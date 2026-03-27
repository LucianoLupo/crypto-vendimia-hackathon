// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
}

interface ICToken {
    function mint(uint256 mintAmount) external returns (uint256);
    function redeemUnderlying(uint256 redeemAmount) external returns (uint256);
    function balanceOf(address owner) external view returns (uint256);
    function exchangeRateStored() external view returns (uint256);
}

interface IMoC {
    function redeemFreeDoc(uint256 docAmount) external;
}

interface ICRbtc {
    function mint() external payable returns (uint256);
    function redeem(uint256 redeemTokens) external returns (uint256);
    function balanceOf(address owner) external view returns (uint256);
    function exchangeRateStored() external view returns (uint256);
}

/// @title SatsPilotDCA — Non-custodial DCA on Rootstock
/// @notice Users deposit DOC, configure DCA schedules. A keeper triggers periodic
///         DOC → RBTC conversions via Money on Chain. Idle DOC earns yield in Tropykus kDOC.
///         Accumulated RBTC earns yield in Tropykus kRBTC.
/// @dev DOC redemption uses MoC's redeemFreeDoc (zero slippage, oracle price, 0.15% fee).
///      No Uniswap needed — DOC is MoC's native stablecoin, so redemption is primary market.
contract SatsPilotDCA {
    // ======================== STRUCTS ========================

    struct Schedule {
        uint256 docBalance;        // DOC deposited (tracked separately from kDOC)
        uint256 purchaseAmount;    // DOC to spend per execution
        uint256 purchasePeriod;    // Seconds between executions (min 1 day)
        uint256 lastExecution;     // Timestamp of last execution
        uint256 accumulatedRbtc;   // RBTC accumulated from purchases
        bool active;
    }

    // ======================== STATE ========================

    bool private _locked;
    mapping(address => Schedule) public schedules;
    address[] public users;
    mapping(address => bool) public isUser;

    address public owner;
    address public keeper;

    uint256 public constant MIN_PURCHASE_AMOUNT = 25e18;  // 25 DOC minimum
    uint256 public constant MIN_PERIOD = 1 days;
    uint256 public constant FEE_BPS = 50; // 0.5% protocol fee
    uint256 public feeAccumulated;

    // ======================== PROTOCOL ADDRESSES (immutable, set at deploy) ========================

    IERC20 public immutable DOC;
    ICToken public immutable KDOC;
    IMoC public immutable MOC;
    ICRbtc public immutable KRBTC;

    // ======================== EVENTS ========================

    event ScheduleCreated(address indexed user, uint256 depositAmount, uint256 purchaseAmount, uint256 purchasePeriod);
    event ScheduleUpdated(address indexed user, uint256 purchaseAmount, uint256 purchasePeriod);
    event ScheduleCancelled(address indexed user, uint256 docRefunded);
    event Deposited(address indexed user, uint256 amount);
    event DocWithdrawn(address indexed user, uint256 amount);
    event RbtcWithdrawn(address indexed user, uint256 amount);
    event DCAExecuted(address indexed user, uint256 docSpent, uint256 rbtcReceived, uint256 fee);
    event KeeperUpdated(address indexed oldKeeper, address indexed newKeeper);
    event DCAFailed(address indexed user, bytes reason);
    event ScheduleDeactivated(address indexed user);

    // ======================== MODIFIERS ========================

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    modifier onlyKeeper() {
        require(msg.sender == keeper, "Not keeper");
        _;
    }

    modifier nonReentrant() {
        require(!_locked, "Reentrant");
        _locked = true;
        _;
        _locked = false;
    }

    // ======================== CONSTRUCTOR ========================

    constructor(
        address _keeper,
        address _doc,
        address _moc,
        address _kdoc,
        address _krbtc
    ) {
        owner = msg.sender;
        keeper = _keeper;
        DOC = IERC20(_doc);
        MOC = IMoC(_moc);
        KDOC = ICToken(_kdoc);
        KRBTC = ICRbtc(_krbtc);
    }

    // ======================== USER FUNCTIONS ========================

    /// @notice Create a DCA schedule and deposit DOC
    function createSchedule(
        uint256 depositAmount,
        uint256 purchaseAmount,
        uint256 purchasePeriod
    ) external {
        require(!schedules[msg.sender].active, "Schedule already exists");
        require(depositAmount > 0, "Deposit must be > 0");
        require(purchaseAmount >= MIN_PURCHASE_AMOUNT, "Purchase amount too low (min 25 DOC)");
        require(purchasePeriod >= MIN_PERIOD, "Period too short (min 1 day)");
        require(purchaseAmount <= depositAmount, "Purchase amount > deposit");

        // Transfer DOC from user to contract
        require(DOC.transferFrom(msg.sender, address(this), depositAmount), "DOC transfer failed");

        // Park DOC in Tropykus kDOC for yield
        _depositToKdoc(depositAmount);

        // Track user
        if (!isUser[msg.sender]) {
            users.push(msg.sender);
            isUser[msg.sender] = true;
        }

        schedules[msg.sender] = Schedule({
            docBalance: depositAmount,
            purchaseAmount: purchaseAmount,
            purchasePeriod: purchasePeriod,
            lastExecution: block.timestamp,
            accumulatedRbtc: 0,
            active: true
        });

        emit ScheduleCreated(msg.sender, depositAmount, purchaseAmount, purchasePeriod);
    }

    /// @notice Add more DOC to existing schedule
    function depositMore(uint256 amount) external {
        require(schedules[msg.sender].active, "No active schedule");
        require(amount > 0, "Amount must be > 0");

        require(DOC.transferFrom(msg.sender, address(this), amount), "DOC transfer failed");
        _depositToKdoc(amount);
        schedules[msg.sender].docBalance += amount;

        emit Deposited(msg.sender, amount);
    }

    /// @notice Withdraw DOC from schedule
    function withdrawDoc(uint256 amount) external nonReentrant {
        Schedule storage s = schedules[msg.sender];
        require(s.active, "No active schedule");
        require(amount > 0 && amount <= s.docBalance, "Invalid amount");

        uint256 remaining = s.docBalance - amount;
        require(remaining == 0 || remaining >= s.purchaseAmount, "Remaining too low for DCA");

        _redeemFromKdoc(amount);
        require(DOC.transfer(msg.sender, amount), "DOC transfer failed");
        s.docBalance -= amount;

        if (s.docBalance == 0) {
            s.active = false;
        }

        emit DocWithdrawn(msg.sender, amount);
    }

    /// @notice Withdraw accumulated RBTC from DCA purchases (redeems from Tropykus kRBTC)
    function withdrawRbtc() external nonReentrant {
        Schedule storage s = schedules[msg.sender];
        uint256 amount = s.accumulatedRbtc;
        require(amount > 0, "No RBTC to withdraw");

        s.accumulatedRbtc = 0;

        // Redeem RBTC from Tropykus kRBTC (user gets their RBTC + any yield earned)
        _redeemRbtcFromKrbtc(amount);

        (bool sent, ) = msg.sender.call{value: amount}("");
        require(sent, "RBTC transfer failed");

        emit RbtcWithdrawn(msg.sender, amount);
    }

    /// @notice Cancel schedule, refund all DOC and RBTC
    function cancelSchedule() external nonReentrant {
        Schedule storage s = schedules[msg.sender];
        require(s.active, "No active schedule");

        uint256 docAmount = s.docBalance;
        uint256 rbtcAmount = s.accumulatedRbtc;

        s.active = false;
        s.docBalance = 0;
        s.accumulatedRbtc = 0;

        if (docAmount > 0) {
            _redeemFromKdoc(docAmount);
            require(DOC.transfer(msg.sender, docAmount), "DOC refund failed");
        }
        if (rbtcAmount > 0) {
            _redeemRbtcFromKrbtc(rbtcAmount);
            (bool sent, ) = msg.sender.call{value: rbtcAmount}("");
            require(sent, "RBTC refund failed");
        }

        emit ScheduleCancelled(msg.sender, docAmount);
    }

    /// @notice Update DCA parameters
    function updateSchedule(uint256 newPurchaseAmount, uint256 newPurchasePeriod) external {
        Schedule storage s = schedules[msg.sender];
        require(s.active, "No active schedule");
        require(newPurchaseAmount >= MIN_PURCHASE_AMOUNT, "Purchase amount too low");
        require(newPurchasePeriod >= MIN_PERIOD, "Period too short");
        require(newPurchaseAmount <= s.docBalance, "Purchase amount > balance");

        s.purchaseAmount = newPurchaseAmount;
        s.purchasePeriod = newPurchasePeriod;

        emit ScheduleUpdated(msg.sender, newPurchaseAmount, newPurchasePeriod);
    }

    // ======================== KEEPER FUNCTIONS ========================

    /// @notice Execute DCA for a single user (keeper only)
    function executeDca(address user) external onlyKeeper {
        _executeDca(user);
    }

    /// @notice Batch execute DCA for multiple users (keeper only)
    function batchExecuteDca(address[] calldata _users) external onlyKeeper {
        for (uint256 i = 0; i < _users.length; i++) {
            try this.executeDcaSelf(_users[i]) {} catch (bytes memory reason) {
                emit DCAFailed(_users[i], reason);
            }
        }
    }

    /// @dev Called by batchExecuteDca via try/catch for error isolation
    function executeDcaSelf(address user) external {
        require(msg.sender == address(this), "Only self");
        _executeDca(user);
    }

    function _executeDca(address user) internal {
        Schedule storage s = schedules[user];
        require(s.active, "Schedule not active");
        require(block.timestamp >= s.lastExecution + s.purchasePeriod, "Too early");
        require(s.docBalance >= s.purchaseAmount, "Insufficient DOC");

        uint256 purchaseAmount = s.purchaseAmount;

        // 1. Redeem DOC from Tropykus kDOC
        _redeemFromKdoc(purchaseAmount);

        // 2. Calculate protocol fee (0.5%)
        uint256 fee = (purchaseAmount * FEE_BPS) / 10000;
        uint256 redeemAmount = purchaseAmount - fee;
        feeAccumulated += fee;

        // 3. Convert DOC → RBTC via Money on Chain (zero slippage, oracle price)
        // No DOC.approve needed — MoC burns DOC directly as token owner
        // MoC may partially redeem if freeDoc < redeemAmount, so measure actual DOC burned
        uint256 docBefore = DOC.balanceOf(address(this));
        uint256 rbtcBefore = address(this).balance;
        MOC.redeemFreeDoc(redeemAmount);
        uint256 docAfter = DOC.balanceOf(address(this));
        uint256 rbtcReceived = address(this).balance - rbtcBefore;
        uint256 docActuallyBurned = docBefore - docAfter;
        require(rbtcReceived > 0, "MoC redemption returned 0");

        // 4. Deposit RBTC into Tropykus kRBTC for yield
        KRBTC.mint{value: rbtcReceived}();

        // 5. Update schedule — only deduct what was actually burned + fee
        uint256 totalDeducted = docActuallyBurned + fee;
        s.docBalance -= totalDeducted;
        s.accumulatedRbtc += rbtcReceived;
        s.lastExecution = block.timestamp;

        // 5. Deactivate if balance too low for next purchase
        if (s.docBalance < s.purchaseAmount) {
            s.active = false;
            emit ScheduleDeactivated(user);
        }

        emit DCAExecuted(user, purchaseAmount, rbtcReceived, fee);
    }

    // ======================== INTERNAL ========================

    function _depositToKdoc(uint256 amount) internal {
        uint256 allowance = DOC.allowance(address(this), address(KDOC));
        if (allowance < amount) {
            DOC.approve(address(KDOC), type(uint256).max);
        }
        uint256 result = KDOC.mint(amount);
        require(result == 0, "kDOC mint failed");
    }

    function _redeemFromKdoc(uint256 amount) internal {
        uint256 result = KDOC.redeemUnderlying(amount);
        require(result == 0, "kDOC redeem failed");
    }

    function _redeemRbtcFromKrbtc(uint256 rbtcAmount) internal {
        // Calculate kRBTC tokens needed to redeem `rbtcAmount` of native RBTC
        // kRBTC uses exchangeRate: underlyingAmount = kTokens * exchangeRate / 1e18
        // So kTokens = underlyingAmount * 1e18 / exchangeRate
        uint256 exchangeRate = KRBTC.exchangeRateStored();
        uint256 kRbtcNeeded = (rbtcAmount * 1e18 + exchangeRate - 1) / exchangeRate; // round up
        uint256 kRbtcBalance = KRBTC.balanceOf(address(this));
        // Redeem all if balance is close (avoid dust)
        uint256 toRedeem = kRbtcNeeded > kRbtcBalance ? kRbtcBalance : kRbtcNeeded;
        if (toRedeem > 0) {
            uint256 result = KRBTC.redeem(toRedeem);
            require(result == 0, "kRBTC redeem failed");
        }
    }

    // ======================== ADMIN ========================

    function setKeeper(address _keeper) external onlyOwner {
        require(_keeper != address(0), "Zero address");
        emit KeeperUpdated(keeper, _keeper);
        keeper = _keeper;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Zero address");
        owner = newOwner;
    }

    function withdrawFees() external onlyOwner {
        uint256 fees = feeAccumulated;
        require(fees > 0, "No fees");
        feeAccumulated = 0;
        // Fee DOC is already on the contract (redeemed during _executeDca), not in kDOC
        require(DOC.transfer(owner, fees), "Fee transfer failed");
    }

    // ======================== VIEW ========================

    function getSchedule(address user) external view returns (Schedule memory) {
        return schedules[user];
    }

    function getDocBalance(address user) external view returns (uint256) {
        return schedules[user].docBalance;
    }

    function getPendingRbtc(address user) external view returns (uint256) {
        return schedules[user].accumulatedRbtc;
    }

    function isDue(address user) external view returns (bool) {
        return _isDue(user);
    }

    function getUserCount() external view returns (uint256) {
        return users.length;
    }

    /// @notice Get all users with due DCA schedules (for keeper batch calls)
    function getDueUsers() external view returns (address[] memory) {
        uint256 len = users.length;
        uint256 count = 0;
        for (uint256 i = 0; i < len; i++) {
            if (_isDue(users[i])) count++;
        }

        address[] memory dueUsers = new address[](count);
        uint256 idx = 0;
        for (uint256 i = 0; i < len; i++) {
            if (_isDue(users[i])) {
                dueUsers[idx++] = users[i];
            }
        }
        return dueUsers;
    }

    function _isDue(address user) internal view returns (bool) {
        Schedule storage s = schedules[user];
        return s.active &&
               block.timestamp >= s.lastExecution + s.purchasePeriod &&
               s.docBalance >= s.purchaseAmount;
    }

    // ======================== RECEIVE ========================

    /// @notice Accept native RBTC from MoC redemption and kRBTC withdrawal
    receive() external payable {
        require(
            msg.sender == address(MOC) || msg.sender == address(KRBTC) || msg.sender == address(this),
            "Only MoC/kRBTC"
        );
    }
}
