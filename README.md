# CL Settlement Engine

This project is a **Chainlink CRE (Chainlink Runtime Environment) workflow** that automatically resolves prediction markets on-chain. It fetches resolvable markets from a Django backend, computes outcomes using NFT floor price data (OpenSea & Alchemy), and writes the results to a smart contract via the CRE Keystone Forwarder.

you can view the smart contract (solidity program) here -> https://github.com/ChijiokeDivine/harbor-predict-main

![screenshot_1 5x](https://github.com/user-attachments/assets/0d98f794-0727-485b-8495-83a7d9bed9ce)


---

## Architecture Overview
<img width="600" height="500" alt="Gemini_Generated_Image" src="https://github.com/user-attachments/assets/363c8bd1-bf09-4f8a-a719-92c310483bdc" />



---

## Detailed Walkthrough: `main.ts`

### 1. Config Schema (lines 19–29)

The workflow expects a JSON config validated by Zod:

- **`schedule`** — Cron expression (e.g. `"0 */1 * * *"` = every hour)
- **`marketApiUrl`** — URL of the Django backend endpoint returning resolvable markets
- **`evm`** — Chain and contract settings:
  - `proxyAddress` — CRE Keystone Forwarder address
  - `consumerAddress` — Contract implementing `onReport(bytes, bytes)`
  - `chainSelectorName` — e.g. `ethereum-testnet-sepolia-base-1`
  - `gasLimit` — Gas limit for the report transaction

**Staging** uses `http://127.0.0.1:8000/api/oracle/resolvable-markets/` (local Django).  
**Production** uses `http://127.0.0.1:8000/api/oracle/resolvable-markets/` (deployed backend hidden).

---

### 2. Django Backend Integration

The workflow calls `GET {marketApiUrl}` to fetch markets. The backend is expected to return:

```json
{
  "markets": [
    {
      "marketId": 1,
      "category": "battle" | "single",
      "chain": "ethereum" | "base" | "berachain" | "monad",
      "collectionA": "0x...",
      "collectionB": "0x...",
      "initialFloorA": "1.5",
      "initialFloorB": "0.8",
      "direction": "bullish" | "bearish",
      "targetPrice": "2.0"
    }
  ]
}
```

- **Battle markets** — `collectionA` vs `collectionB`; outcome = which collection’s floor price grew more (24hr percentage).
- **Single markets** — One `collectionA`; outcome = floor ≥ target (bullish) or ≤ target (bearish).

The code normalizes optional fields and ignores `"None"` strings. Fields `collectionA`, `collectionB`, `initialFloorA`, `initialFloorB`, `direction`, and `targetPrice` are optional; omit them or use `null` if not applicable.

---

### 3. Secrets Management

API keys are loaded via CRE secrets (not in config):

```ts
const alchemyApiKey = runtime.getSecret({ id: 'ALCHEMY_API_KEY' }).result().value
const openSeaApiKey = runtime.getSecret({ id: 'OPENSEA_API_KEY' }).result().value
```

Declared in `secrets.yaml` and provided via `.env` or environment variables. Must be fetched in DON mode (outside `sendRequest` callbacks).

---

### 4. HTTP Requests & DON Consensus

All external HTTP calls use `HTTPClient.sendRequest()` with `ConsensusAggregationByFields`. This:

1. Runs the request on each node in the DON
2. Aggregates responses via consensus (here: `identical` = all nodes must agree)
3. Returns a single trusted result

**Django fetch** — `sendRequest` callback receives `(sendRequester, config)`; the URL comes from `config.marketApiUrl`.

**OpenSea** — Used when `chain` is `berachain` or `monad`. Expects collection slug. URL:  
`https://api.opensea.io/api/v2/collections/{slug}/stats`

**Alchemy** — Used when `chain` is `ethereum` or `base`. Expects contract address. URL:  
`https://eth-mainnet.g.alchemy.com/nft/v3/{apiKey}/getNFTMetadata?contractAddress=...&tokenId=1`  
(or `base-mainnet.g.alchemy.com` for Base)

Floor prices are wrapped in `{ floor: number }` because `ConsensusAggregationByFields` requires object types, not primitives.

---

### 5. Outcome Computation (`computeOutcome`)

- **Battle** — Growth % = `(finalFloor - initialFloor) / initialFloor * 100`. Outcome = `growthA > growthB`.
- **Bullish** — Outcome = `floor >= targetPrice`
- **Bearish** — Outcome = `floor <= targetPrice`

---

### 6. On-Chain Report

1. Encode payload: `abi.encode(uint256 marketId, bool outcome)` using viem
2. `runtime.report()` — CRE produces a signed report
3. `EVMClient.writeReport()` — Sends the report to the Keystone Forwarder
4. Consumer contract’s `onReport(bytes metadata, bytes report)` receives and decodes the data

---

### 7. Workflow Entry Point

- **`initWorkflow(config)`** — Registers a cron handler with `doResolution` as the callback.
- **`main()`** — Creates the Runner, validates config, and runs the workflow.

---

## Getting Started (Original Template)

This template provides an end-to-end Proof-of-Reserve (PoR) example (including precompiled smart contracts). It's designed to showcase key CRE capabilities and help you get started with local simulation quickly.

Follow the steps below to run the example:

## 1. Initialize CRE project

Start by initializing a new CRE project. This will scaffold the necessary project structure and a template workflow. Run cre init in the directory where you'd like your CRE project to live.

Example output:

```
Project name?: my_cre_project
✔ Custom data feed: Typescript updating on-chain data periodically using offchain API data
✔ Workflow name?: workflow01
```

## 2. Update .env file

Add a private key and API keys to the `.env` file. The private key is required for chain writes; it must be valid and funded.

**Required:**
- `CRE_ETH_PRIVATE_KEY` — For signing on-chain report transactions
- `ALCHEMY_API_KEY` — For Ethereum/Base NFT floor price fetches
- `OPENSEA_API_KEY` — For Berachain/Monad NFT floor price fetches

Example:
```
CRE_ETH_PRIVATE_KEY=0000000000000000000000000000000000000000000000000000000000000001
ALCHEMY_API_KEY="your-alchemy-api-key"
OPENSEA_API_KEY="your-opensea-api-key"
```

If your workflow does not do any chain write, you can keep a dummy key. Ensure `secrets.yaml` maps these names (see project root).

## 3. Install dependencies

If `bun` is not already installed, see https://bun.com/docs/installation for installing in your environment.

```bash
cd <workflow-name> && bun install
```

Example: For a workflow directory named `workflow01` the command would be:

```bash
cd workflow01 && bun install
```

## 4. Configure RPC endpoints

For local simulation to interact with a chain, you must specify RPC endpoints for the chains you interact with in the `project.yaml` file. This is required for submitting transactions and reading blockchain state.

Note: The following 7 chains are supported in local simulation (both testnet and mainnet variants):

- Ethereum (`ethereum-testnet-sepolia`, `ethereum-mainnet`)
- Base (`ethereum-testnet-sepolia-base-1`, `ethereum-mainnet-base-1`)
- Avalanche (`avalanche-testnet-fuji`, `avalanche-mainnet`)
- Polygon (`polygon-testnet-amoy`, `polygon-mainnet`)
- BNB Chain (`binance-smart-chain-testnet`, `binance-smart-chain-mainnet`)
- Arbitrum (`ethereum-testnet-sepolia-arbitrum-1`, `ethereum-mainnet-arbitrum-1`)
- Optimism (`ethereum-testnet-sepolia-optimism-1`, `ethereum-mainnet-optimism-1`)

Add your preferred RPCs under the `rpcs` section. For chain names, refer to https://github.com/smartcontractkit/chain-selectors/blob/main/selectors.yml

## 5. Deploy contracts and prepare ABIs

### 5a. Deploy contracts

**Settlement engine:** The consumer contract must implement `onReport(bytes metadata, bytes report)` (see `contracts/abi/IReceiverTemplate.ts`). The workflow encodes `abi.encode(uint256 marketId, bool outcome)`; the contract decodes the report accordingly.

**PoR template:** Deploy the BalanceReader, MessageEmitter, ReserveManager and SimpleERC20 contracts on a local chain or testnet using cast/foundry. Pre-deployed Sepolia addresses exist for quick starts.

### 5b. Prepare ABIs

For each contract you would like to interact with, you need to provide the ABI `.ts` file so that TypeScript can provide type safety and autocomplete for the contract methods. The format of the ABI files is very similar to regular JSON format; you just need to export it as a variable and mark it `as const`. For example:

```ts
// IERC20.ts file
export const IERC20Abi = {
  // ... your ABI here ...
} as const;
```

For a quick start, every contract used in this workflow is already provided in the `contracts` folder. You can use them as a reference.

## 6. Configure workflow

Configure `config.staging.json` or `config.production.json` for the settlement workflow:

- **`schedule`** — Cron expression (e.g. `"0 */1 * * *"` for every hour). See [CRON service quotas](https://docs.chain.link/cre/service-quotas)
- **`marketApiUrl`** — Django backend URL returning resolvable markets:
  - Staging: `http://127.0.0.1:8000/api/oracle/resolvable-markets/` (local Django)
  - Production: `http://127.0.0.1:8000/api/oracle/resolvable-markets/`
- **`evm.proxyAddress`** — CRE Keystone Forwarder address on the target chain
- **`evm.consumerAddress`** — Contract implementing `onReport(bytes, bytes)` to receive market outcomes
- **`evm.chainSelectorName`** — Chain name (e.g. `ethereum-testnet-sepolia-base-1`). See [chain-selectors](https://github.com/smartcontractkit/chain-selectors/blob/main/selectors.yml)
- **`evm.gasLimit`** — Gas limit for the report transaction

Add `ALCHEMY_API_KEY` and `OPENSEA_API_KEY` to your `.env` file; declare them in `secrets.yaml` and set `secrets-path: "../secrets.yaml"` in `workflow.yaml`.

Note: Make sure your `workflow.yaml` file is pointing to the correct config, example:

```yaml
staging-settings:
  user-workflow:
    workflow-name: "CL-settlement-engine-staging"
  workflow-artifacts:
    workflow-path: "./main.ts"
    config-path: "./config.staging.json"
    secrets-path: "../secrets.yaml"
```

## 7. Simulate the workflow

Run the command from the **project root directory** and pass the workflow path and target:

```bash
cre workflow simulate CL-settlement-engine --target staging-settings
```

For a custom workflow directory:

```bash
cre workflow simulate ./workflow01 --target staging-settings
```

Ensure the Django backend is running locally (e.g. `http://127.0.0.1:8000`) when using `config.staging.json`.

After this the workflow should immediately execute.

<img width="650" height="183" alt="image" src="https://github.com/user-attachments/assets/8cd3a6a3-09ac-4759-8e7a-5a1cff227a26" />


