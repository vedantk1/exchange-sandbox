import { useId } from 'react';
import { amount } from './amounts.js';
import type { MarketView } from './types.js';

/** Text uses the API's exact decimal strings; canvas coordinates are only a visual aid. */
export function CandleData({ candles }: { candles: MarketView['candles'] }) {
  const captionId = useId();
  return (
    <details className="trader-candle-data">
      <summary>
        View candle data{' '}
        <span>
          {candles.length} {candles.length === 1 ? 'minute' : 'minutes'} with trades
        </span>
      </summary>
      <p>
        One-minute executions in UTC, newest first. Empty minutes stay empty. Prices are USD-SIM per
        BTC-SIM; volume is BTC-SIM. Values preserve the precision returned by the exchange.
      </p>
      {candles.length ? (
        <div className="trader-table-scroll" role="region" aria-labelledby={captionId} tabIndex={0}>
          <table className="trader-table">
            <caption id={captionId}>Candle data · UTC</caption>
            <thead>
              <tr>
                <th scope="col">Minute · UTC</th>
                <th scope="col" className="numeric">
                  Open
                </th>
                <th scope="col" className="numeric">
                  High
                </th>
                <th scope="col" className="numeric">
                  Low
                </th>
                <th scope="col" className="numeric">
                  Close
                </th>
                <th scope="col" className="numeric">
                  Volume · BTC-SIM
                </th>
              </tr>
            </thead>
            <tbody>
              {[...candles].reverse().map((candle) => (
                <tr key={candle.timestamp}>
                  <th scope="row">
                    <time dateTime={candle.timestamp}>
                      {new Date(candle.timestamp).toISOString().slice(0, 16).replace('T', ' ')}
                    </time>
                  </th>
                  <td className="numeric">{amount(candle.open)}</td>
                  <td className="numeric">{amount(candle.high)}</td>
                  <td className="numeric">{amount(candle.low)}</td>
                  <td className="numeric">{amount(candle.close)}</td>
                  <td className="numeric">{amount(candle.volume, 4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p>No candle data is available until orders execute.</p>
      )}
    </details>
  );
}
