# Flappy Bears 🐻

A bear-market survival game. The level is the real last-24h candlestick chart for BTC/ETH/SOL (CoinGecko OHLC, 30-min candles) drawn at true chart positions with price/time axes. Rule: fly OVER green candles, UNDER red ones — volatile days are brutal levels. Survive all 48 candles to win.

Inspired by [Stonk Rider](https://stonkrider.com); design system mirrored from [app.ethos.network](https://app.ethos.network).

**Live**: https://flappybears.sethgholson.com

## Stack

Vanilla JS + canvas. No build step. Served by nginx (see `Dockerfile`).

## Run locally

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

## Controls

Tap / click / Space to flap. Don't get rekt.
