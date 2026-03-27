# SatsPilot

**Tu copiloto cripto en WhatsApp** — DCA automatizado en Bitcoin desde WhatsApp, con conversión DOC a RBTC sin slippage via Money on Chain y generación de yield automática en Rootstock.

## Qué Hace

1. Mandás un mensaje de WhatsApp: "Quiero invertir 5 dólares en bitcoin cada semana"
2. El bot parsea tu intención (regex local o Claude 3.5 Haiku via OpenRouter)
3. Crea una orden DCA que se ejecuta automáticamente en tu frecuencia elegida
4. Convierte DOC a RBTC via Money on Chain (`redeemFreeDoc`) — precio oráculo, cero slippage
5. Mientras los DOC esperan, generan ~5% anual en Tropykus kDOC
6. Smart DCA: compra más cuando el precio baja, menos cuando sube

Sin MetaMask. Sin wallet connect. Solo WhatsApp.

## Componentes

El proyecto tiene dos componentes principales:

| Componente | Tecnología | Descripción |
|------------|-----------|-------------|
| **Smart Contract** | Solidity / Foundry | `SatsPilotDCA.sol` — contrato no custodial que gestiona depósitos, DCA schedules, yield y retiros on-chain |
| **Backend** | Node.js / TypeScript / Express | Bot de WhatsApp que interactúa con el contrato como "keeper" — solo puede disparar ejecuciones programadas, no acceder a fondos |

## Arquitectura

```
Usuario WhatsApp
    │ "comprar 10 RBTC diario"
    ▼
Kapso.ai (WhatsApp Cloud API de Meta)
    │ Webhook POST con HMAC signature
    ▼
SatsPilot Backend (Node.js / TypeScript — rol de "keeper")
    │ Parser de intenciones → Router de comandos → Llamadas al contrato
    ▼
SatsPilotDCA.sol (Smart Contract en Rootstock)
    ├── Tropykus kDOC ──── DOC idle genera ~5% APY
    ├── Money on Chain ─── redeemFreeDoc() para DOC → RBTC (oráculo, 0 slippage)
    └── Tropykus kRBTC ─── RBTC acumulado genera yield en lending
        │
        ▼
    Rootstock Blockchain (EVM, asegurada por el hashrate de Bitcoin)
```

### Modelo de seguridad: custodial con lógica on-chain

**Transparencia total sobre el modelo de custodia:**

El smart contract `SatsPilotDCA` fue diseñado para ser **no custodial** — los fondos viven en el contrato, el keeper solo puede disparar compras, y solo el `msg.sender` original puede retirar sus fondos.

Sin embargo, dado que la interfaz es **WhatsApp** (sin MetaMask ni wallet web3), el backend necesita firmar transacciones en nombre del usuario usando wallets HD derivadas del mnemónico maestro. Esto significa:

- **El backend firma el `DOC.approve()` y `createSchedule()`** en nombre del usuario — porque el usuario no tiene cómo firmar desde WhatsApp
- **En la práctica, el backend tiene acceso a las claves privadas** — lo que hace el modelo custodial a nivel de firma, aunque la lógica DCA corre on-chain
- **La ventaja del contrato** es que la lógica de DCA, yield, y fees es **transparente y verificable on-chain** — no es una caja negra
- **El keeper solo llama `executeDca()`** — pero como el backend también controla las wallets de los usuarios, teóricamente podría llamar `withdrawDoc()` o `cancelSchedule()` en su nombre

**Para alcanzar un modelo verdaderamente no custodial**, se necesitaría:
- Account Abstraction (ERC-4337) con session keys limitadas
- O una companion web app donde el usuario firma con su propia wallet
- O integración con wallets como Beexo que soportan firma desde móvil

**Para el hackathon**, este modelo híbrido es apropiado: la lógica on-chain agrega transparencia y verificabilidad, mientras que la experiencia de usuario sigue siendo puro WhatsApp sin fricción técnica.

## Smart Contract: SatsPilotDCA

> **Estado: DESPLEGADO EN TESTNET.** Contrato en RSK testnet: `0xFB7C51D09Da311204d9eCA7791c3C7A47d0E2A4c`. Deploy a mainnet pendiente.

### Interfaz

```solidity
contract SatsPilotDCA {
    struct Schedule {
        uint256 docBalance;        // DOC depositado
        uint256 purchaseAmount;    // DOC a gastar por ejecución
        uint256 purchasePeriod;    // Segundos entre ejecuciones (mín. 1 día)
        uint256 lastExecution;     // Timestamp de última ejecución
        uint256 accumulatedRbtc;   // RBTC acumulado de las compras
        bool active;
    }

    // --- Funciones del usuario ---
    function createSchedule(uint256 depositAmount, uint256 purchaseAmount, uint256 purchasePeriod) external;
    function depositMore(uint256 amount) external;
    function withdrawDoc(uint256 amount) external;
    function withdrawRbtc() external;
    function cancelSchedule() external;
    function updateSchedule(uint256 newPurchaseAmount, uint256 newPurchasePeriod) external;

    // --- Funciones del keeper (solo el servidor) ---
    function executeDca(address user) external;
    function batchExecuteDca(address[] calldata users) external;

    // --- Funciones de consulta ---
    function getSchedule(address user) external view returns (Schedule memory);
    function getDocBalance(address user) external view returns (uint256);
    function getPendingRbtc(address user) external view returns (uint256);
    function isDue(address user) external view returns (bool);
    function getDueUsers() external view returns (address[] memory);
}
```

### Cómo funciona la conversión DOC a RBTC

DOC es la stablecoin nativa de Money on Chain, colateralizada por Bitcoin. En lugar de usar un DEX (con slippage y riesgo de MEV), el contrato usa `redeemFreeDoc()` para redimir DOC en el mercado primario:

- **Precio oráculo**: Money on Chain usa su propio oráculo de BTC/USD — no hay slippage
- **Comisión MoC**: ~0.15% por redención
- **Comisión del protocolo SatsPilot**: 0.5% por ejecución DCA
- **Sin dependencia de liquidez en pools**: la redención es directa contra las reservas de MoC

### Flujo de ejecución DCA

```
executeDca(user):
1. Verificar msg.sender == keeper
2. Verificar schedule activo y período cumplido
3. Redimir DOC de Tropykus kDOC → obtener DOC líquido
4. Calcular fee del protocolo (0.5%)
5. Llamar MoC.redeemFreeDoc(docAmount) → recibir RBTC nativo
6. Depositar RBTC en Tropykus kRBTC (genera yield mientras el usuario no retira)
7. Acumular RBTC en el schedule del usuario
7. Actualizar balance y timestamp
8. Desactivar schedule si el balance es insuficiente para la próxima compra
```

### Contratos externos utilizados

| Contrato | Dirección (RSK Mainnet) | Uso |
|----------|------------------------|-----|
| DOC (stablecoin) | `0xe700691dA7b9851F2F35f8b8182c69c53CcaD9Db` | Token fuente para DCA |
| Tropykus kDOC | `0x544Eb90e766B405134b3B3F62b6b4C23Fcd5fDa2` | Yield para DOC idle (~5% APY) |
| Money on Chain (MoC) | `0xf773B590aF754D597770937Fa8ea7AbDf2668370` | Redención DOC → RBTC (oráculo, 0 slippage) |
| Tropykus kRBTC | `0x0AEAdb9d4C6A80462A47e87E76E487Fa8B9a37d7` | Yield para RBTC acumulado |

### Build y test del contrato

```bash
cd contracts
forge build
forge test
```

## Features

- **DCA por lenguaje natural** — "Comprar 5 RBTC diario", "Invertir 10 DOC semanal"
- **Smart DCA** — Ajusta montos basándose en precio actual vs SMA de 7 días (CoinGecko)
- **Conversión sin slippage** — DOC → RBTC via Money on Chain `redeemFreeDoc()` a precio oráculo
- **Idle Yield** — DOC depositados generan ~5% anual en Tropykus kDOC mientras esperan el próximo DCA
- **No custodial** — Los fondos viven en el smart contract; el servidor solo dispara ejecuciones programadas
- **Multi-Token** — RBTC, DOC, RIF, SOV, DLLR, rUSDT
- **Gestión de órdenes** — Pausar, reanudar, cancelar órdenes DCA via WhatsApp
- **Retiros** — Retirar DOC o RBTC acumulado a cualquier dirección externa
- **Detección de depósitos** — Notifica via WhatsApp cuando se detectan nuevos fondos

## Tech Stack

| Capa | Tecnología |
|------|-----------|
| Smart Contract | [Solidity](https://soliditylang.org) ^0.8.19 + [Foundry](https://getfoundry.sh) |
| WhatsApp API | [Kapso.ai](https://kapso.ai) (wrapper oficial de Meta WhatsApp Cloud API) |
| AI/NLP | Claude 3.5 Haiku via [OpenRouter](https://openrouter.ai) + regex local como fallback |
| Blockchain | [Rootstock](https://rootstock.io) (sidechain EVM de Bitcoin) |
| DOC → RBTC | [Money on Chain](https://moneyonchain.com) `redeemFreeDoc()` (oráculo, 0 slippage) |
| Yield (DOC) | [Tropykus](https://tropykus.com) kDOC (~5% APY) |
| Yield (RBTC) | [Tropykus](https://tropykus.com) kRBTC lending |
| Backend | Node.js, TypeScript, Express |
| Base de datos | SQLite via better-sqlite3 + Drizzle ORM |
| Scheduling | node-cron (cada minuto) |
| Hosting | [Railway](https://railway.app) |

## Contratos en Rootstock

Las direcciones se seleccionan automáticamente según la red (mainnet/testnet) configurada en `RSK_RPC_URL`.

### RSK Testnet (chainId 31) — Desplegado

| Contrato | Dirección (Testnet) |
|----------|-----------|
| **SatsPilotDCA** | `0xFB7C51D09Da311204d9eCA7791c3C7A47d0E2A4c` |
| Money on Chain (MoC) | `0x2820f6d4D199B8D8838A4B26F9917754B86a0c1F` |
| Tropykus kDOC | `0x71e6B108d823C2786f8EF63A3E0589576B4F3914` |
| Tropykus kRBTC | `0x5b35072cd6110606c8421e013304110fa04a32a3` |
| DOC | `0xCB46c0ddc60D18eFEB0E586C17Af6ea36452Dae0` |
| RIF | `0x19f64674d8a5b4e652319f5e239efd3bc969a1fe` |

### RSK Mainnet (chainId 30) — Pendiente de deploy

| Contrato | Dirección (Mainnet) |
|----------|-----------|
| SatsPilotDCA | **Pendiente de deploy** |
| Money on Chain (MoC) | `0xf773b590af754d597770937fa8ea7abdf2668370` |
| Tropykus kDOC | `0x544eb90e766b405134b3b3f62b6b4c23fcd5fda2` |
| Tropykus kRBTC | `0x0aeadb9d4c6a80462a47e87e76e487fa8b9a37d7` |
| DOC | `0xe700691da7b9851f2f35f8b8182c69c53ccad9db` |
| WRBTC | `0x542fda317318ebf1d3deaf76e0b632741a7e677d` |
| rUSDT | `0xef213441a85df4d7acbdae0cf78004e1e486bb96` |

Todas las direcciones de mainnet están en lowercase para evitar problemas con el checksum EIP-1191 de RSK (chainId 30). El contrato usa `immutable` en lugar de `constant` para soportar ambas redes con el mismo código.

## Seguridad y Modelo de Confianza

### Modelo no custodial (smart contract)

Con `SatsPilotDCA.sol`, los fondos de los usuarios viven en el contrato, no en wallets controladas por el servidor:

- **El keeper (servidor) solo puede disparar `executeDca()`** — no puede retirar fondos ni modificar schedules de los usuarios
- **Los usuarios retiran sus fondos directamente** llamando `withdrawDoc()`, `withdrawRbtc()` o `cancelSchedule()`
- **El contrato es inmutable una vez desplegado** — las reglas de ejecución están en código, no en el servidor

> **Importante: el contrato NO ha sido auditado.** Es código de hackathon. No depositar fondos significativos sin una auditoría profesional.

### Riesgos del contrato

- **Sin auditoría** — el contrato no fue revisado por auditores de seguridad
- **Dependencia de protocolos externos** — los fondos en Tropykus kDOC y Money on Chain están sujetos al riesgo de smart contract de esos protocolos
- **Keeper centralizado** — si el servidor deja de funcionar, las ejecuciones DCA se pausan (pero los fondos siguen accesibles para retiro)
- **Sin proxy/upgradeability** — si se encuentra un bug, se necesita migrar a un nuevo contrato
- **Fee del protocolo** — 0.5% por ejecución DCA, configurable solo por el owner

### Componente backend (aún parcialmente custodial)

El backend todavía gestiona wallets derivadas HD para funciones como retiros y balances. Esta capa se irá migrando al contrato progresivamente:

- Cada usuario se identifica por su número de WhatsApp (`from` field del webhook de Kapso)
- Kapso/Meta garantizan la autenticidad del número — no se puede spoofear
- Todas las queries a la DB filtran por `user_id` — un usuario no puede ver ni operar las órdenes de otro
- Las wallets se derivan determinísticamente: `m/44'/137'/0'/0/{userIndex}`

### Rol del modelo de IA (Claude 3.5 Haiku)

El LLM funciona **únicamente como clasificador de intenciones**:

- Recibe el texto del mensaje y devuelve un JSON con `action` y `params`
- **No tiene acceso a tools**, wallets, claves privadas, ni al blockchain
- **No puede inyectar direcciones** — los tokens se resuelven contra una whitelist hardcodeada en `tokens.ts`
- **No puede ejecutar operaciones** — solo clasifica la intención; el backend valida todo antes de ejecutar
- Si el LLM devuelve un token no soportado, la validación en `commands.ts` lo rechaza
- Los comandos comunes (ayuda, balance, estado, DCA con patrón simple) se parsean localmente con regex, sin llamar al LLM

### Validaciones del backend

- Montos validados: positivos, no mayores a 10,000 por ejecución
- Tokens validados contra whitelist (RBTC, DOC, RIF, SOV, DLLR, RUSDT)
- Frecuencias validadas: solo hourly, daily, weekly
- Monto mínimo de DCA en el contrato: 25 DOC por ejecución
- Período mínimo en el contrato: 1 día
- Guard de concurrencia en el scheduler (evita ejecuciones dobles)
- Null checks en `tx.wait()` (ethers v6 puede devolver null si la tx se dropea)

### Qué NO se implementó (limitaciones del hackathon)

- El contrato SatsPilotDCA no está desplegado en mainnet
- No hay auditoría del smart contract
- No hay encriptación del mnemónico en reposo (se lee directo del env var)
- No hay rate limiting en el webhook (cada request no autenticado igual se procesa)
- No hay validación de formato del número de teléfono
- La base de datos SQLite no está encriptada
- No hay replay protection en webhooks (se verifica HMAC pero no se trackean message IDs)
- Los errores de ethers.js se loguean completos (podrían filtrar info sensible)
- SQLite en Railway es efímero — los datos se pierden en cada redeploy. Para producción: usar Railway Volumes o migrar a PostgreSQL.
- No hay comando de retiro automático de fondos de yield pools en caso de emergencia del protocolo.

## Setup

### Prerequisitos

- Node.js 20+
- [Foundry](https://getfoundry.sh) (para compilar y testear el smart contract)
- Cuenta en [Kapso.ai](https://kapso.ai) (tier gratis — 2,000 msgs/mes)
- API key de [OpenRouter](https://openrouter.ai) (opcional — regex local cubre comandos básicos)
- Cuenta en [Railway](https://railway.app) (para deploy)

### Instalación

```bash
git clone https://github.com/LucianoLupo/crypto-vendimia-hackathon.git
cd crypto-vendimia-hackathon
npm install

# Compilar el smart contract
cd contracts
forge build
```

### Variables de Entorno

```bash
cp .env.example .env
```

| Variable | Descripción | Requerida |
|----------|-------------|-----------|
| `KAPSO_API_KEY` | API key de Kapso.ai | Sí |
| `KAPSO_WEBHOOK_SECRET` | Secret HMAC del webhook de Kapso | Sí |
| `KAPSO_PHONE_NUMBER_ID` | ID del número de teléfono de WhatsApp | Sí |
| `MASTER_MNEMONIC` | Mnemonic BIP39 para derivación de wallets HD | Sí |
| `RSK_RPC_URL` | RPC de Rootstock (`https://public-node.rsk.co`) | Sí |
| `OPENROUTER_API_KEY` | API key de OpenRouter para parsing con IA | Opcional* |
| `PORT` | Puerto del servidor (default: 3000) | No |

*Los comandos comunes (ayuda, balance, estado, start, patrones de DCA) funcionan via regex local sin API key. OpenRouter solo se necesita para parsing de lenguaje natural ("quiero invertir 5 dólares en bitcoin cada semana").

### Ejecutar

```bash
# Desarrollo
npm run dev

# Producción
npm run build
npm start
```

### Deploy en Railway

```bash
railway init
railway up
railway domain  # Obtener URL pública
```

Configurar la URL de Railway + `/webhook` como endpoint del webhook en Kapso.

## Comandos de WhatsApp

El bot acepta comandos en español e inglés:

| Comando | Ejemplo |
|---------|---------|
| **Empezar** | "hola", "start", "buenas" |
| **DCA** | "comprar 10 RBTC diario", "invertir 5 DOC semanal" |
| **Balance** | "saldo", "balance", "ver mi balance" |
| **Estado** | "estado", "mis órdenes", "status" |
| **Pausar** | "pausar orden #3", "pausar" |
| **Reanudar** | "reanudar", "continuar" |
| **Cancelar** | "cancelar orden #2", "cancelar" |
| **Depositar** | "depositar", "mi dirección" |
| **Invertir** | "invertir", "parquear" (deposita DOC en Tropykus ~5% APY) |
| **Retirar** | "retirar 0.5 RBTC a 0x...", "withdraw 10 DOC to 0x..." |
| **Ayuda** | "ayuda", "help", "comandos" |

## Cómo Funciona el DCA + Yield

```
Usuario configura: "Comprar 10 RBTC diario" (default: DOC como token fuente)
    │
    ▼ Cada día (scheduler cron, corre cada minuto)
    │
    ├── Idle Yield: retira DOC de Tropykus kDOC si hay fondos parqueados
    │
    ├── Smart DCA consulta precio actual vs SMA 7 días (CoinGecko API)
    │   ├── Precio 5%+ debajo del SMA → compra 15 DOC (50% más)
    │   ├── Precio 5%+ arriba del SMA → compra 5 DOC (50% menos)
    │   └── Rango normal → compra 10 DOC (monto base)
    │
    ├── Keeper llama executeDca() en SatsPilotDCA.sol
    │   ├── Redime DOC de Tropykus kDOC
    │   ├── Cobra 0.5% fee del protocolo
    │   ├── Llama MoC.redeemFreeDoc() → recibe RBTC nativo (precio oráculo, 0 slippage)
    │   └── Acumula RBTC en el schedule del usuario
    │
    ├── Registra ejecución en DB (tx hashes, montos, estado)
    │
    └── Notifica al usuario via WhatsApp con links al explorer
```

## Estructura del Proyecto

```
├── contracts/                    # Smart contract (Foundry)
│   ├── src/
│   │   └── SatsPilotDCA.sol      # Contrato principal: DCA no custodial
│   ├── test/                     # Tests del contrato
│   ├── script/                   # Scripts de deploy
│   └── foundry.toml              # Configuración de Foundry
│
└── src/                          # Backend (Node.js / TypeScript)
    ├── index.ts                  # Entry point: Express + scheduler + deposit watcher
    ├── config/
    │   ├── env.ts                # Validación de env vars con Zod
    │   └── tokens.ts             # Direcciones de tokens y contratos en RSK
    ├── db/
    │   ├── schema.ts             # Drizzle schema: users, dca_orders, executions
    │   └── index.ts              # Conexión SQLite + funciones de query
    ├── routes/
    │   └── webhook.ts            # Handler de webhook de Kapso
    └── services/
        ├── parser.ts             # Clasificador de intenciones: regex local → OpenRouter fallback
        ├── commands.ts           # Router de comandos: despacha a handlers por acción
        ├── wallet.ts             # Derivación HD, balances on-chain
        ├── swap.ts               # Swaps Uniswap V3 (legacy, siendo reemplazado por MoC)
        ├── yield.ts              # Depósitos Sovryn: iToken.mint/burn
        ├── idle-yield.ts         # Tropykus kDOC: park/unpark DOC libres
        ├── scheduler.ts          # Cron cada minuto: busca órdenes vencidas, ejecuta DCA
        ├── smart-dca.ts          # Precio vs SMA 7 días (CoinGecko), ajusta monto ±50%
        ├── deposit-watcher.ts    # Polling cada 60s: detecta nuevos depósitos
        └── whatsapp.ts           # Envío de mensajes via Kapso REST API
```

## Built For

[Vendimia Hackathon](https://vendimia.io) — Crypto / Web3 / AI

## License

MIT
