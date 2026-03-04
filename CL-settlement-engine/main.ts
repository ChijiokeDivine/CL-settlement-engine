import {
  ConsensusAggregationByFields,
  handler,
  CronCapability,
  EVMClient,
  HTTPClient,
  getNetwork,
  hexToBase64,
  Runner,
  TxStatus,
  identical,
} from '@chainlink/cre-sdk'

import { encodeAbiParameters, parseAbiParameters } from 'viem'
import { z } from 'zod'

/* ================= CONFIG ================= */

const configSchema = z.object({
  schedule: z.string(),
  marketApiUrl: z.string(),
  evm: z.object({
    proxyAddress: z.string(),
    consumerAddress: z.string(),
    chainSelectorName: z.string(),
    gasLimit: z.string(),
  }),
})

type Config = z.infer<typeof configSchema>

/* ================= TYPES ================= */

interface MarketResponse {
  marketId: number
  category: string
  chain: string
  collectionA?: string
  collectionB?: string
  initialFloorA?: string
  initialFloorB?: string
  direction?: string
  targetPrice?: string
}

interface BatchMarketResponse {
  markets: MarketResponse[]
}

// Primitives must be wrapped in objects for ConsensusAggregationByFields
interface FloorPriceResult {
  floor: number
}

interface OpenSeaStatsResponse {
  total?: { floor_price?: number | string }
}

interface AlchemyNFTResponse {
  contract?: { openSeaMetadata?: { floorPrice?: number | string } }
}

/* ================= FLOOR PRICE HELPERS ================= */

function fetchOpenSeaFloorViaHTTP(
  runtime: any,
  http: HTTPClient,
  slug: string,
  openSeaApiKey: string,
): number {
  const response = http
    .sendRequest(
      runtime,
      (sendRequester) => {
        const res = sendRequester
          .sendRequest({
            method: 'GET',
            url: `https://api.opensea.io/api/v2/collections/${slug}/stats`,
            headers: {
              accept: '*/*',
              'X-API-KEY': openSeaApiKey,
            },
          })
          .result()

        const data = JSON.parse(
          Buffer.from(res.body).toString(),
        ) as OpenSeaStatsResponse

        // Must return an object — ConsensusAggregationByFields does not accept primitives
        return { floor: Number(data.total?.floor_price ?? 0) } as FloorPriceResult
      },
      ConsensusAggregationByFields<FloorPriceResult>({
        floor: identical,
      }),
    )()
    .result()

  return response.floor
}

function fetchAlchemyFloorViaHTTP(
  runtime: any,
  http: HTTPClient,
  contract: string,
  chain: string,
  alchemyApiKey: string,
): number {
  const endpoints: Record<string, string> = {
    ethereum: 'https://eth-mainnet.g.alchemy.com',
    base: 'https://base-mainnet.g.alchemy.com',
  }

  const baseUrl = endpoints[chain]
  if (!baseUrl) throw new Error(`Unsupported chain: ${chain}`)

  const response = http
    .sendRequest(
      runtime,
      (sendRequester) => {
        const res = sendRequester
          .sendRequest({
            method: 'GET',
            url: `${baseUrl}/nft/v3/${alchemyApiKey}/getNFTMetadata?contractAddress=${contract}&tokenId=1`,
          })
          .result()

        const data = JSON.parse(
          Buffer.from(res.body).toString(),
        ) as AlchemyNFTResponse

        // Must return an object
        return {
          floor: Number(data.contract?.openSeaMetadata?.floorPrice ?? 0),
        } as FloorPriceResult
      },
      ConsensusAggregationByFields<FloorPriceResult>({
        floor: identical,
      }),
    )()
    .result()

  return response.floor
}

/* ================= MARKET RESOLUTION LOGIC ================= */

interface ApiKeys {
  openSeaApiKey: string
  alchemyApiKey: string
}

function computeOutcome(
  runtime: any,
  http: HTTPClient,
  market: MarketResponse,
  keys: ApiKeys,
): boolean {
  if (market.category.toLowerCase() === 'battle') {
    const finalA = fetchOpenSeaFloorViaHTTP(runtime, http, market.collectionA!, keys.openSeaApiKey)
    const finalB = fetchOpenSeaFloorViaHTTP(runtime, http, market.collectionB!, keys.openSeaApiKey)

    const growthA =
      ((finalA - Number(market.initialFloorA)) / Number(market.initialFloorA)) * 100
    const growthB =
      ((finalB - Number(market.initialFloorB)) / Number(market.initialFloorB)) * 100

    return growthA > growthB
  }

  const floor =
    market.chain === 'berachain' || market.chain === 'monad'
      ? fetchOpenSeaFloorViaHTTP(runtime, http, market.collectionA!, keys.openSeaApiKey)
      : fetchAlchemyFloorViaHTTP(runtime, http, market.collectionA!, market.chain, keys.alchemyApiKey)

  if (market.direction === 'bullish') {
    return floor >= Number(market.targetPrice)
  }

  if (market.direction === 'bearish') {
    return floor <= Number(market.targetPrice)
  }

  throw new Error(`Invalid direction: ${market.direction}`)
}

/* ================= ONCHAIN CALL ================= */

function resolveMarketOnChain(
  runtime: any,
  marketId: bigint,
  outcome: boolean,
): string {
  const network = getNetwork({
    chainFamily: 'evm',
    chainSelectorName: runtime.config.evm.chainSelectorName,
    isTestnet: true,
  })

  if (!network) {
    throw new Error(`Unknown chain: ${runtime.config.evm.chainSelectorName}`)
  }

  const evmClient = new EVMClient(network.chainSelector.selector)

  // Raw abi.encode(uint256, bool) — matches abi.decode in your contract's onReport()
  const reportPayload = encodeAbiParameters(
    parseAbiParameters('uint256, bool'),
    [marketId, outcome],
  )

  const reportResponse = runtime
    .report({
      encodedPayload: hexToBase64(reportPayload),
      encoderName: 'evm',
      signingAlgo: 'ecdsa',
      hashingAlgo: 'keccak256',
    })
    .result()

  const resp = evmClient
    .writeReport(runtime, {
      receiver: runtime.config.evm.proxyAddress, // Keystone Forwarder
      report: reportResponse,
      gasConfig: {
        gasLimit: runtime.config.evm.gasLimit,
      },
    })
    .result()

  if (resp.txStatus !== TxStatus.SUCCESS) {
    throw new Error(
      `On-chain resolution failed for market ${marketId} — tx status: ${resp.txStatus}`,
    )
  }

  return marketId.toString()
}

/* ================= WORKFLOW ================= */

const doResolution = async (runtime: any): Promise<string> => {
  const http = new HTTPClient()

  const alchemyApiKey = runtime.getSecret({ id: 'ALCHEMY_API_KEY' }).result().value
  const openSeaApiKey = runtime.getSecret({ id: 'OPENSEA_API_KEY' }).result().value
  const keys: ApiKeys = { openSeaApiKey, alchemyApiKey }

  // Fetch resolvable markets — through HTTPClient for DON consensus
  const response = http
    .sendRequest(
      runtime,
      (sendRequester, config: Config) => {
        const res = sendRequester
          .sendRequest({
            method: 'GET',
            url: config.marketApiUrl,
          })
          .result()

          const parsed = JSON.parse(
            Buffer.from(res.body).toString()
          )

          const markets: MarketResponse[] = (parsed.markets ?? []).map((m: any) => {
            // Build a clean object — only include keys that have real values
            const clean: MarketResponse = {
              marketId: m.marketId,
              category: m.category,
              chain: m.chain,
            }
          
            // Only attach optional fields if they are non-null and not the string "None"
            if (m.collectionA != null) clean.collectionA = m.collectionA
            if (m.collectionB != null) clean.collectionB = m.collectionB
            if (m.direction != null) clean.direction = m.direction
            if (m.targetPrice != null) clean.targetPrice = m.targetPrice
            if (m.initialFloorA != null && m.initialFloorA !== 'None') clean.initialFloorA = m.initialFloorA
            if (m.initialFloorB != null && m.initialFloorB !== 'None') clean.initialFloorB = m.initialFloorB
          
            return clean
          })
          
          return {
            markets
          } as BatchMarketResponse
      },
      ConsensusAggregationByFields<BatchMarketResponse>({
        markets: identical,
      }),
    )(runtime.config)
    .result()

  if (!response.markets || response.markets.length === 0) {
    return 'No markets to resolve'
  }

  const resolvedIds: string[] = []
  const failedIds: string[] = []

  for (const market of response.markets) {
    try {
      const outcome = computeOutcome(runtime, http, market, keys)

      const txId = resolveMarketOnChain(
        runtime,
        BigInt(market.marketId),
        outcome,
      )

      resolvedIds.push(txId)
      console.log(`✅ Resolved market ${market.marketId} → outcome: ${outcome}`)
    } catch (err) {
      failedIds.push(market.marketId.toString())
      console.log(`❌ Failed resolving market ${market.marketId}:`, err)
    }
  }

  const summary = [
    resolvedIds.length > 0 ? `Resolved: ${resolvedIds.join(', ')}` : null,
    failedIds.length > 0 ? `Failed: ${failedIds.join(', ')}` : null,
  ]
    .filter(Boolean)
    .join(' | ')

  return summary || 'Nothing processed'
}

const initWorkflow = (config: Config) => {
  const cron = new CronCapability()

  return [
    handler(
      cron.trigger({ schedule: config.schedule }),
      doResolution,
    ),
  ]
}

export async function main() {
  const runner = await Runner.newRunner<Config>({
    configSchema,
  })
  await runner.run(initWorkflow)
}