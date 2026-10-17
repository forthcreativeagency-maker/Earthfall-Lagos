# Earthfall — Lagos Rising

A browser-based multiplayer survival game. Climb a rope from Lagos to the Moon while the world collapses around you. Two game modes, real-time multiplayer, voice chat, in-game economy, and Paystack-powered coin purchases.

**Play:** https://earthfall-mp.fly.dev

## Features

- Two game modes: The Climb (rope) and The Jump (clouds)
- Real-time multiplayer up to 12 players per room via Socket.IO
- 15-second voice chat relayed through the server
- EarthCoins economy — earn by reaching milestones
- Betting system — wager coins on other players
- Shop with real-money coin purchases (Paystack)
- Character selection with 6 unique climbers
- Server-side chat moderation

## Tech stack

- Node.js + Express
- Socket.IO for real-time sync
- SQLite for accounts and economy
- HTML5 Canvas for all rendering
- Paystack for payments

## Local setup

    git clone https://github.com/forthcreativeagency-maker/Earthfall-Lagos.git
    cd Earthfall-Lagos
    npm install

Set your Paystack test key, then run:

    $env:PAYSTACK_SECRET_KEY="sk_test_xxx"
    node server.js

Open http://localhost:3000

## Deploy

    flyctl secrets set PAYSTACK_SECRET_KEY=sk_live_xxx
    flyctl deploy

Set your Paystack webhook to https://your-app.fly.dev/paystack/webhook

## Licence

MIT