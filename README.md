# SatsPilot

**Tu copiloto cripto en WhatsApp** — DCA automatizado en Bitcoin desde WhatsApp, con comandos por lenguaje natural y generacion de yield automatica en Rootstock.

## Que Hace

1. Mandas un mensaje de WhatsApp → "Quiero invertir 5 dolares en bitcoin cada semana"
2. El bot parsea tu intencion (regex local o Claude 3.5 Haiku via OpenRouter)
3. Crea una orden DCA que se ejecuta automaticamente en tu frecuencia elegida
4. Ejecuta swaps en Uniswap V3 desplegado en Rootstock
5. Auto-deposita los tokens comprados en Sovryn lending para generar yield
6. Smart DCA: compra mas cuando el precio baja, menos cuando sube

Sin MetaMask. Sin wallet connect. Solo WhatsApp.

## Arquitectura

```
Usuario WhatsApp
    │ "comprar 10 RBTC diario"
    ▼
Kapso.ai (WhatsApp Cloud API de Meta)
    │ Webhook POST con HMAC signature
    ▼
SatsPilot Backend (Node.js / TypeScript / Express)
    ├── Parser de intenciones (regex local + Claude 3.5 Haiku via OpenRouter)
    ├── Router de comandos (start, dca, balance, status, ayuda...)
    ├── Wallet Manager (derivacion HD por usuario)
    ├── Swap Executor (Uniswap V3 SwapRouter02 en Rootstock)
    ├── Yield Depositor (Sovryn iToken lending)
    ├── Idle Yield (Tropykus kDOC ~5% APY para DOC libres)
    ├── Scheduler DCA (node-cron, cada minuto)
    ├── Smart DCA (analisis precio vs SMA 7 dias via CoinGecko)
    └── Deposit Watcher (monitoreo de RBTC + rUSDT + DOC cada 60s)
        │
        ▼
    Rootstock Blockchain (EVM, asegurada por el hashrate de Bitcoin)
```

## Features

- **DCA por lenguaje natural** — "Comprar 5 RBTC diario", "Invertir 10 DOC semanal"
- **Smart DCA** — Ajusta montos basandose en precio actual vs SMA de 7 dias (CoinGecko)
- **Auto-Yield** — Tokens comprados se depositan en Sovryn lending automaticamente
- **Idle Yield** — DOC libres generan ~5% anual en Tropykus kDOC mientras esperan el proximo DCA
- **Multi-Token** — RBTC, DOC, RIF, SOV, DLLR, rUSDT
- **Wallet por usuario** — Derivacion HD deterministica desde un mnemonic maestro
- **Gestion de ordenes** — Pausar, reanudar, cancelar ordenes DCA via WhatsApp
- **Deteccion de depositos** — Notifica via WhatsApp cuando se detectan nuevos fondos

## Tech Stack

| Capa | Tecnologia |
|------|-----------|
| WhatsApp API | [Kapso.ai](https://kapso.ai) (wrapper oficial de Meta WhatsApp Cloud API) |
| AI/NLP | Claude 3.5 Haiku via [OpenRouter](https://openrouter.ai) + regex local como fallback |
| Blockchain | [Rootstock](https://rootstock.io) (sidechain EVM de Bitcoin) |
| DEX | Uniswap V3 (SwapRouter02 desplegado en RSK) |
| Yield | [Sovryn](https://sovryn.app) iToken lending + [Tropykus](https://tropykus.com) kDOC idle yield |
| Backend | Node.js, TypeScript, Express |
| Base de datos | SQLite via better-sqlite3 + Drizzle ORM |
| Scheduling | node-cron (cada minuto) |
| Hosting | [Railway](https://railway.app) |

## Contratos en Rootstock

| Contrato | Direccion |
|----------|-----------|
| SwapRouter02 (Uniswap V3) | `0x0b14ff67f0014046b4b99057aec4509640b3947a` |
| QuoterV2 (Uniswap V3) | `0xb51727c996c68e60f598a923a5006853cd2feb31` |
| V3Factory (Uniswap V3) | `0xaf37ec98a00fd63689cf3060bf3b6784e00cad82` |
| Sovryn iRBTC | `0xa9dcdc63eabb8a2b6f39d7ff9429d88340044a7a` |
| Sovryn iDOC | `0xd8d25f03ebba94e15df2ed4d6d38276b595593c1` |
| Sovryn iDLLR | `0x077fcb01cab070a30bc14b44559c96f529ee017f` |
| Tropykus kDOC | `0x544eb90e766b405134b3b3f62b6b4c23fcd5fda2` |
| WRBTC | `0x542fda317318ebf1d3deaf76e0b632741a7e677d` |
| rUSDT | `0xef213441a85df4d7acbdae0cf78004e1e486bb96` |
| DOC | `0xe700691da7b9851f2f35f8b8182c69c53ccad9db` |

Todas las direcciones estan en lowercase para evitar problemas con el checksum EIP-1191 de RSK (chainId 30).

## Seguridad y Modelo de Confianza

### Modelo custodial

SatsPilot es **custodial** — el servidor tiene el mnemonic maestro desde el cual se derivan todas las wallets de los usuarios. Esto significa:

- **El operador del bot tiene acceso completo** a todos los fondos de todos los usuarios
- **Si el servidor o las variables de entorno se comprometen**, todas las wallets estan en riesgo
- Para un hackathon esto es aceptable con montos pequenos; para produccion se deberia migrar a smart contract vaults o account abstraction

### Aislamiento entre usuarios

- Cada usuario se identifica por su numero de WhatsApp (`from` field del webhook de Kapso)
- Kapso/Meta garantizan la autenticidad del numero — no se puede spoofear
- Todas las queries a la DB filtran por `user_id` — un usuario no puede ver ni operar las ordenes de otro
- Las wallets se derivan deterministicamente: `m/44'/137'/0'/0/{userIndex}` — cada usuario tiene su propia wallet

### Rol del modelo de IA (Claude 3.5 Haiku)

El LLM funciona **unicamente como clasificador de intenciones**:

- Recibe el texto del mensaje y devuelve un JSON con `action` y `params`
- **No tiene acceso a tools**, wallets, claves privadas, ni al blockchain
- **No puede inyectar direcciones** — los tokens se resuelven contra una whitelist hardcodeada en `tokens.ts`
- **No puede ejecutar operaciones** — solo clasifica la intencion; el backend valida todo antes de ejecutar
- Si el LLM devuelve un token no soportado, la validacion en `commands.ts` lo rechaza
- Los comandos comunes (ayuda, balance, estado, DCA con patron simple) se parsean localmente con regex, sin llamar al LLM

### Validaciones del backend

- Montos validados: positivos, no mayores a 10,000 por ejecucion
- Tokens validados contra whitelist (RBTC, DOC, RIF, SOV, DLLR, RUSDT)
- Frecuencias validadas: solo hourly, daily, weekly
- Approvals de tokens: monto exacto (no MaxUint256)
- Swaps con deadline de 5 minutos (proteccion contra MEV)
- Slippage: 1% por defecto
- Guard de concurrencia en el scheduler (evita ejecuciones dobles)
- Null checks en `tx.wait()` (ethers v6 puede devolver null si la tx se dropea)

### Que NO se implemento (limitaciones del hackathon)

- No hay encriptacion del mnemonic en reposo (se lee directo del env var)
- No hay rate limiting en el webhook (cada request no autenticado igual se procesa)
- No hay validacion de formato del numero de telefono
- La base de datos SQLite no esta encriptada
- No hay replay protection en webhooks (se verifica HMAC pero no se trackean message IDs)
- Los errores de ethers.js se loguean completos (podrian filtrar info sensible)

## Setup

### Prerequisitos

- Node.js 20+
- Cuenta en [Kapso.ai](https://kapso.ai) (tier gratis — 2,000 msgs/mes)
- API key de [OpenRouter](https://openrouter.ai) (opcional — regex local cubre comandos basicos)
- Cuenta en [Railway](https://railway.app) (para deploy)

### Instalacion

```bash
git clone https://github.com/LucianoLupo/crypto-vendimia-hackathon.git
cd crypto-vendimia-hackathon
npm install
```

### Variables de Entorno

```bash
cp .env.example .env
```

| Variable | Descripcion | Requerida |
|----------|-------------|-----------|
| `KAPSO_API_KEY` | API key de Kapso.ai | Si |
| `KAPSO_WEBHOOK_SECRET` | Secret HMAC del webhook de Kapso | Si |
| `KAPSO_PHONE_NUMBER_ID` | ID del numero de telefono de WhatsApp | Si |
| `MASTER_MNEMONIC` | Mnemonic BIP39 para derivacion de wallets HD | Si |
| `RSK_RPC_URL` | RPC de Rootstock (`https://public-node.rsk.co`) | Si |
| `OPENROUTER_API_KEY` | API key de OpenRouter para parsing con IA | Opcional* |
| `PORT` | Puerto del servidor (default: 3000) | No |

*Los comandos comunes (ayuda, balance, estado, start, patrones de DCA) funcionan via regex local sin API key. OpenRouter solo se necesita para parsing de lenguaje natural ("quiero invertir 5 dolares en bitcoin cada semana").

### Ejecutar

```bash
# Desarrollo
npm run dev

# Produccion
npm run build
npm start
```

### Deploy en Railway

```bash
railway init
railway up
railway domain  # Obtener URL publica
```

Configurar la URL de Railway + `/webhook` como endpoint del webhook en Kapso.

## Comandos de WhatsApp

El bot acepta comandos en espanol e ingles:

| Comando | Ejemplo |
|---------|---------|
| **Empezar** | "hola", "start", "buenas" |
| **DCA** | "comprar 10 RBTC diario", "invertir 5 DOC semanal" |
| **Balance** | "saldo", "balance", "ver mi balance" |
| **Estado** | "estado", "mis ordenes", "status" |
| **Pausar** | "pausar orden #3", "pausar" |
| **Reanudar** | "reanudar", "continuar" |
| **Cancelar** | "cancelar orden #2", "cancelar" |
| **Depositar** | "depositar", "mi direccion" |
| **Invertir** | "invertir", "parquear" (deposita DOC en Tropykus ~5% APY) |
| **Ayuda** | "ayuda", "help", "comandos" |

## Como Funciona el DCA + Yield

```
Usuario configura: "Comprar 10 RBTC diario" (default: DOC como token fuente)
    │
    ▼ Cada dia (scheduler cron, corre cada minuto)
    │
    ├── Idle Yield: retira DOC de Tropykus kDOC si hay fondos parqueados
    │
    ├── Smart DCA consulta precio actual vs SMA 7 dias (CoinGecko API)
    │   ├── Precio 5%+ debajo del SMA → compra 15 DOC (50% mas)
    │   ├── Precio 5%+ arriba del SMA → compra 5 DOC (50% menos)
    │   └── Rango normal → compra 10 DOC (monto base)
    │
    ├── Ejecuta swap en Uniswap V3 (DOC → WRBTC via SwapRouter02)
    │   ├── Obtiene quote via QuoterV2
    │   ├── Aplica 1% slippage tolerance
    │   ├── Approve del monto exacto al router
    │   └── exactInputSingle con deadline de 5 minutos
    │
    ├── Auto-deposita RBTC en Sovryn iRBTC (si autoYield esta activado)
    │   └── Llama iToken.mint() con el monto recibido del swap
    │
    ├── Idle Yield: re-deposita DOC restante en Tropykus kDOC (si > 100 DOC)
    │
    ├── Registra ejecucion en DB (tx hashes, montos, estado)
    │
    └── Notifica al usuario via WhatsApp con links al explorer
```

## Estructura del Proyecto

```
src/
├── index.ts                  # Entry point: Express + scheduler + deposit watcher
├── config/
│   ├── env.ts                # Validacion de env vars con Zod (falla al iniciar si faltan)
│   └── tokens.ts             # Direcciones de tokens y contratos en RSK (hardcoded)
├── db/
│   ├── schema.ts             # Drizzle schema: users, dca_orders, executions
│   └── index.ts              # Conexion SQLite + funciones de query
├── routes/
│   └── webhook.ts            # Handler de webhook de Kapso (parsea payload batched)
└── services/
    ├── parser.ts             # Clasificador de intenciones: regex local → OpenRouter fallback
    ├── commands.ts           # Router de comandos: despacha a handlers por accion
    ├── wallet.ts             # Derivacion HD (m/44'/137'/0'/0/{n}), balances on-chain
    ├── swap.ts               # Swaps Uniswap V3: quote, approve, exactInputSingle
    ├── yield.ts              # Depositos Sovryn: iToken.mint/burn, balance checking
    ├── idle-yield.ts         # Tropykus kDOC: park/unpark DOC libres para generar yield
    ├── scheduler.ts          # Cron cada minuto: busca ordenes vencidas, ejecuta swap+yield
    ├── smart-dca.ts          # Precio vs SMA 7 dias (CoinGecko), ajusta monto ±50%
    ├── deposit-watcher.ts    # Polling cada 60s: detecta nuevos depositos RBTC + rUSDT + DOC
    └── whatsapp.ts           # Envio de mensajes via Kapso REST API
```

## Built For

[Vendimia Hackathon](https://vendimia.io) — Crypto / Web3 / AI

## License

MIT
