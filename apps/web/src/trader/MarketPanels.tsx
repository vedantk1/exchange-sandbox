import { useEffect, useRef } from 'react';
import {
  CandlestickSeries,
  ColorType,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import { amount, timeLabel, units } from './amounts.js';
import type { MarketView } from './types.js';

export function CandleChart({ candles = [] }: { candles: MarketView['candles'] }) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const firstPaint = useRef(true);

  useEffect(() => {
    if (!container.current) return;
    chart.current = createChart(container.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: '#111923' },
        textColor: '#899bab',
        fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
        fontSize: 11,
        attributionLogo: true,
      },
      grid: { vertLines: { color: '#1c2833' }, horzLines: { color: '#1c2833' } },
      rightPriceScale: { borderColor: '#28343f' },
      timeScale: { borderColor: '#28343f', timeVisible: true, secondsVisible: false },
    });
    series.current = chart.current.addSeries(CandlestickSeries, {
      upColor: '#57d5bc',
      downColor: '#f18b83',
      borderVisible: false,
      wickUpColor: '#57d5bc',
      wickDownColor: '#f18b83',
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    });
    return () => {
      chart.current?.remove();
      chart.current = null;
      series.current = null;
      firstPaint.current = true;
    };
  }, []);

  useEffect(() => {
    // Approximate chart coordinates never flow back into trading or accounting.
    series.current?.setData(
      candles.map((candle) => ({
        time: Math.floor(new Date(candle.timestamp).getTime() / 1000) as UTCTimestamp,
        open: Number(candle.open),
        high: Number(candle.high),
        low: Number(candle.low),
        close: Number(candle.close),
      })),
    );
    if (firstPaint.current && candles.length) {
      chart.current?.timeScale().fitContent();
      firstPaint.current = false;
    }
  }, [candles]);

  return (
    <div className="trader-chart-area">
      <div
        ref={container}
        className="trader-chart-canvas"
        aria-label="One-minute candle chart of local executions"
      />
      {candles.length === 0 && (
        <div className="trader-chart-empty">
          <span className="trader-empty-mark" aria-hidden="true">
            ↗
          </span>
          <strong>A market starts with a trade.</strong>
          <p>Place a limit order to join the book. Candles appear when orders match.</p>
        </div>
      )}
    </div>
  );
}

export function PriceChart({ market }: { market: MarketView }) {
  const latest = market.trades[0];
  return (
    <section className="trader-panel trader-price-panel" aria-labelledby="price-heading">
      <div className="trader-panel-header">
        <div>
          <h2 id="price-heading">
            Market chart <span className="trader-tag">1m</span>
          </h2>
          <span className="trader-caption">Local executions · USD-SIM per BTC-SIM</span>
        </div>
        <div className="trader-last-price">
          <strong>{latest ? amount(latest.price) : '—'}</strong>
          <span>Last execution</span>
        </div>
      </div>
      <CandleChart candles={market.candles ?? []} />
      <div className="trader-chart-footer">
        <span>1m candles · UTC · empty intervals stay empty.</span>
        <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">
          Charts by TradingView
        </a>
      </div>
    </section>
  );
}

export function OrderBook({
  market,
  onPrice,
}: {
  market: MarketView;
  onPrice?: (price: string) => void;
}) {
  const bids = market.book.bids.slice(0, 7);
  const asks = market.book.asks.slice(0, 7);
  const depths = [...bids, ...asks].map((level) => units(level.quantity, 4));
  const maximum = depths.reduce((max, depth) => (depth > max ? depth : max), 1n);
  const bid = bids[0];
  const ask = asks[0];
  const spread = bid && ask ? units(ask.price, 2) - units(bid.price, 2) : null;
  const formatSpread =
    spread === null ? '—' : `${spread / 100n}.${(spread % 100n).toString().padStart(2, '0')}`;

  function levels(rows: typeof bids, side: 'bid' | 'ask') {
    return rows.length ? (
      rows.map((level) => (
        <div className={`trader-book-row ${side}`} key={level.price}>
          <span
            className="trader-depth"
            style={{ width: `${(units(level.quantity, 4) * 100n) / maximum}%` }}
            aria-hidden="true"
          />
          {onPrice ? (
            <button
              type="button"
              className="trader-price-button"
              onClick={() => onPrice(level.price)}
              aria-label={`Use ${level.price} as limit price`}
            >
              {amount(level.price)}
            </button>
          ) : (
            <span>{amount(level.price)}</span>
          )}
          <span>{amount(level.quantity, 4)}</span>
        </div>
      ))
    ) : (
      <div className="trader-book-empty">No resting {side === 'bid' ? 'buy' : 'sell'} orders</div>
    );
  }

  return (
    <section className="trader-panel trader-book" aria-labelledby="book-heading">
      <div className="trader-panel-header">
        <h2 id="book-heading">Order book</h2>
        <span className="trader-caption">Price priority</span>
      </div>
      <div className="trader-book-labels">
        <span>
          Price <small>USD-SIM</small>
        </span>
        <span>
          Quantity <small>BTC-SIM</small>
        </span>
      </div>
      <div className="trader-book-levels trader-asks">{levels([...asks].reverse(), 'ask')}</div>
      <div className="trader-spread">
        <span>Spread</span>
        <strong>
          {formatSpread === '—' ? '—' : amount(formatSpread)} <small>USD-SIM</small>
        </strong>
      </div>
      <div className="trader-book-levels">{levels(bids, 'bid')}</div>
      <div className="trader-panel-note">
        Top 7 levels per side. Orders match inside this installation.
      </div>
    </section>
  );
}

export function RecentTrades({ market }: { market: MarketView }) {
  return (
    <section className="trader-panel trader-recent-trades" aria-labelledby="trades-heading">
      <div className="trader-panel-header">
        <h2 id="trades-heading">Recent trades</h2>
        <span className="trader-caption">Local market</span>
      </div>
      <div className="trader-trades-head">
        <span>Price · USD-SIM</span>
        <span>BTC-SIM</span>
        <span>Time</span>
      </div>
      {market.trades.length ? (
        <div className="trader-trade-list">
          {market.trades.slice(0, 12).map((trade) => (
            <div className="trader-trade-row" key={`${trade.sequence}:${trade.fillIndex}`}>
              <span>{amount(trade.price)}</span>
              <span>{amount(trade.quantity, 4)}</span>
              <time dateTime={trade.timestamp}>{timeLabel(trade.timestamp)}</time>
            </div>
          ))}
        </div>
      ) : (
        <div className="trader-empty small">
          <strong>No executions yet</strong>
          <p>
            Resting orders are visible in the book. A trade appears when compatible orders meet.
          </p>
        </div>
      )}
    </section>
  );
}
