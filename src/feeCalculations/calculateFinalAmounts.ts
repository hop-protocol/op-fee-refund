import Level from 'level-ts'
import { BigNumber, utils } from 'ethers'
import { DbEntry, FinalEntries, Transfer } from '../interfaces'
import { getTokenPrice } from './fetchTokenPrices'
import {
  nativeTokens,
  tokenDecimals
} from '../constants'

const { formatUnits, parseUnits } = utils

export async function calculateFinalAmounts (
  db: Level,
  refundPercentage: number,
  refundTokenSymbol: string,
  endTimestamp: number
): Promise<FinalEntries> {
  const finalEntries: FinalEntries = {}
  const iterator = db.iterate({ all: 'address::', keys: true })
  for await (const { key, value } of iterator) {
    const dbEntry: DbEntry = value
    const address = dbEntry.address
    // console.log(`processing dbEntry ${address}`)
    const transfers: Transfer[] = dbEntry.transfers

    let amount: BigNumber = BigNumber.from('0')
    for (const transfer of transfers) {
      if (
        transfer.isAggregator ||
        transfer.timestamp > endTimestamp
      ) {
        // console.log(transfer.chain, transfer.hash, transfer.timestamp, endTimestamp)
        continue
      }

      const refundAmountAfterDiscountWei = await getRefundAmount(db, transfer, refundTokenSymbol, refundPercentage)

      amount = amount.add(refundAmountAfterDiscountWei)
      // console.log(`done processing dbEntry ${address}`)
    }

    if (amount.toString() !== '0') {
      amount = amount.sub(value.amountClaimed)
      finalEntries[address] = amount.toString()
    }
  }

  return finalEntries
}

export async function getRefundAmount (db: Level, transfer: Transfer, refundTokenSymbol: string, refundPercentage: number): Promise<BigNumber> {
  // Calculate total amount
  const totalUsdCost = await getUsdCost(db, transfer)
  const symbol = refundTokenSymbol
  const price = await getTokenPrice(db, symbol, transfer.timestamp)
  const refundAmount = totalUsdCost / price

  // Apply refund discount
  const decimals = tokenDecimals[symbol]
  const refundAmountAfterDiscount = refundAmount * refundPercentage
  const refundAmountAfterDiscountWei = parseUnits(refundAmountAfterDiscount.toString(), decimals)
  return refundAmountAfterDiscountWei
}

async function getUsdCost (db: Level, transfer: Transfer): Promise<number> {
  // Source tx fee
  let txCost = BigNumber.from(0)
  if (transfer.gasCost) {
    txCost = BigNumber.from(transfer.gasCost)
  } else {
    const gasUsed = BigNumber.from(transfer.gasUsed!)
    const gasPrice = BigNumber.from(transfer.gasPrice!)
    txCost = gasUsed.mul(gasPrice)
  }
  const nativeTokenSymbol = nativeTokens[transfer.chain]
  const nativeTokenDecimals = 18
  const sourceTxCostUsd = await getFeeInUsd(
    db,
    txCost,
    nativeTokenSymbol,
    nativeTokenDecimals,
    transfer.timestamp
  )

  // Bonder fee
  const bonderFee = BigNumber.from(transfer.bonderFee)
  const bonderFeeSymbol = transfer.token
  const bonderFeeTokenDecimals = tokenDecimals[transfer.token]
  const bonderFeeUsd = await getFeeInUsd(
    db,
    bonderFee,
    bonderFeeSymbol,
    bonderFeeTokenDecimals,
    transfer.timestamp
  )

  // AMM fee
  const swapFeeBps = '4'
  const ammFee = BigNumber.from(transfer.amount).mul(swapFeeBps).div('10000')
  const ammFeeSymbol = transfer.token
  const ammFeeTokenDecimals = tokenDecimals[transfer.token]
  const ammFeeUsd = await getFeeInUsd(
    db,
    ammFee,
    ammFeeSymbol,
    ammFeeTokenDecimals,
    transfer.timestamp
  )

  return sourceTxCostUsd + bonderFeeUsd + ammFeeUsd
}

async function getFeeInUsd (
  db: Level,
  costInAsset: BigNumber,
  symbol: string,
  decimals: number,
  timestamp: number
): Promise<number> {
  const price = await getTokenPrice(db, symbol, timestamp)
  const formattedCost = formatUnits(costInAsset, decimals)
  return parseFloat(formattedCost) * price
}
