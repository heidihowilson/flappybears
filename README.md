# Flappy Bears 🐻

A bear-market survival game. Flap a bear through real crypto candlestick charts — the gap path follows actual BTC/ETH/SOL price action (CoinGecko OHLC, last 30 days), and each candle pair is green or red based on the real candle's direction.

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
