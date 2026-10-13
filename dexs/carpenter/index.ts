import { Dependencies, FetchOptions, SimpleAdapter } from "../../adapters/types";
import { CHAIN } from "../../helpers/chains";
import { queryDuneSql } from "../../helpers/dune";
import { assertDuneSolanaIndexed } from "../../helpers/duneSolanaDex";
import { getMultipleAccounts, base58Encode } from "../../helpers/solana";

// Carpenter (https://github.com/gudtekdonkey/carpenter-sdk): a concentrated-liquidity AMM on Solana with
// Uniswap-v4-style hooks. Every swap emits `Swapped` through `emit_cpi!`, an inner instruction of the program
// itself whose data is EVENT_IX_TAG (8 bytes) || sha256("event:Swapped")[..8] || borsh(event). The query sums each
// pool's swaps by direction; the pool's two mints are read from its account (they never change).
const CARPENTER_AMM = 'DdeiDx4ncHo9DXGZm1GrPe7mFKv7kNU3yx95uQEV2APA';
const SWAPPED = '0xe445a52e51cb9a1dd93434539387606d';

// The Swapped payload, 1-based positions in the instruction data (16 header bytes first):
// pool 17 (32) · trader 49 (32) · zero_for_one 81 (1) · amount_in 82 (u64) · amount_out 90 (u64) ·
// hook_delta0 98 (i128) · hook_delta1 114 (i128) · lp_fee_total 130 (u64, in the input token) ·
// fee_override 138 (Option<u32>: a tag byte, then 4 bytes when Some). After it, from `o` (143 when Some, 139 when None):
// pre_sqrt o (16) · pre_tick o+16 (4) · post_sqrt o+20 (16) · post_tick o+36 (4) · signals o+40 · bid_replaced o+41 ·
// absorbed o+42 (8) · nudge_spent o+50 (8) · protocol_fee_total o+58 (u64) · protocol_fee_currency o+66 (0 / 1).
const QUERY = `
  WITH swaps AS (
    SELECT
      data,
      IF(bytearray_substring(data, 138, 1) = 0x01, 143, 139) AS o
    FROM solana.instruction_calls
    WHERE executing_account = '${CARPENTER_AMM}'
      AND tx_success
      AND bytearray_substring(data, 1, 16) = ${SWAPPED}
      AND TIME_RANGE
  )
  SELECT
    to_base58(bytearray_substring(data, 17, 32)) AS pool,
    bytearray_substring(data, 81, 1) = 0x01 AS zero_for_one,
    bytearray_substring(data, o + 66, 1) = 0x01 AS protocol_fee_in1,
    CAST(SUM(bytearray_to_uint256(bytearray_reverse(bytearray_substring(data, 82, 8)))) AS VARCHAR) AS amount_in,
    CAST(SUM(bytearray_to_uint256(bytearray_reverse(bytearray_substring(data, 90, 8)))) AS VARCHAR) AS amount_out,
    CAST(SUM(bytearray_to_uint256(bytearray_reverse(bytearray_substring(data, 130, 8)))) AS VARCHAR) AS lp_fee,
    CAST(SUM(bytearray_to_uint256(bytearray_reverse(bytearray_substring(data, o + 58, 8)))) AS VARCHAR) AS protocol_fee
  FROM swaps
  GROUP BY 1, 2, 3
`;

// One side of each swap is counted. Where a pool holds one of these, its side is the one counted; otherwise the input.
const CORE = new Set([
  'So11111111111111111111111111111111111111112', // wSOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

// Pool.mint0 / Pool.mint1, after the 8-byte discriminator.
const MINT0 = 8 + 24;
const MINT1 = 8 + 56;

async function poolMints(pools: string[]): Promise<Map<string, [string, string]>> {
  const accounts = await getMultipleAccounts({ chain: CHAIN.SOLANA, accounts: pools });
  const out = new Map<string, [string, string]>();
  accounts.forEach((a: any, i: number) => {
    if (!a) return;
    const data = Buffer.from(a.data[0], 'base64');
    out.set(pools[i], [base58Encode(data.subarray(MINT0, MINT0 + 32)), base58Encode(data.subarray(MINT1, MINT1 + 32))]);
  });
  return out;
}

const fetch = async (options: FetchOptions) => {
  assertDuneSolanaIndexed(options);
  const dailyVolume = options.createBalances();
  const dailyFees = options.createBalances();
  const dailyRevenue = options.createBalances();
  const dailySupplySideRevenue = options.createBalances();

  const rows: any[] = await queryDuneSql(options, QUERY);
  const mints = await poolMints([...new Set(rows.map((r) => r.pool))]);

  for (const r of rows) {
    const pair = mints.get(r.pool);
    if (!pair) continue;
    const [mint0, mint1] = pair;
    const input = r.zero_for_one ? mint0 : mint1;
    const output = r.zero_for_one ? mint1 : mint0;

    if (CORE.has(input) || !CORE.has(output)) dailyVolume.add(input, r.amount_in);
    else dailyVolume.add(output, r.amount_out);

    dailyFees.add(input, r.lp_fee, 'LP fees');
    dailySupplySideRevenue.add(input, r.lp_fee, 'LP fees');
    const protocolMint = r.protocol_fee_in1 ? mint1 : mint0;
    dailyFees.add(protocolMint, r.protocol_fee, 'Protocol fees');
    dailyRevenue.add(protocolMint, r.protocol_fee, 'Protocol fees');
  }

  return { dailyVolume, dailyFees, dailyRevenue, dailyProtocolRevenue: dailyRevenue, dailySupplySideRevenue };
};

const adapter: SimpleAdapter = {
  version: 2,
  fetch,
  chains: [CHAIN.SOLANA],
  start: '2026-10-12',
  dependencies: [Dependencies.DUNE],
  isExpensiveAdapter: true,
  methodology: {
    Volume: 'One side of every Carpenter swap, from the program\'s Swapped events: the SOL / USDC / USDT side where a pool has one, otherwise the input.',
    Fees: 'LP fees and protocol fees charged on Carpenter swaps, from the Swapped events. Fees charged by a pool\'s hook belong to that hook\'s protocol and are not counted here.',
    Revenue: 'The protocol fee.',
    ProtocolRevenue: 'The protocol fee.',
    SupplySideRevenue: 'The LP fee, paid to liquidity providers.',
  },
  breakdownMethodology: {
    Fees: {
      'LP fees': 'Swapped.lp_fee_total, in the input token.',
      'Protocol fees': 'Swapped.protocol_fee_total, in the currency the event names.',
    },
  },
};

export default adapter;
