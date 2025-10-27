<div align="center"><h1>VeeriBot</h1></div>

A simple, versatile Discord verification bot that stops alt accounts and VPN/proxy users from ruining your server. An open-source alternative to [Double Counter](https://doublecounter.gg/).

## What it does

- Blocks vpns, proxies, and dc connections (https://ipapi.is/)
- Prevents alt accounts
- Lets you verify for different roles
- Tracks all attempts so you can see whats happening :eyes:

## How do I set this up?

You need:
- Node.js 
- PostgreSQL database
- Discord bot application
- Domain or localhost for testing
- API key from https://ipapi.is/
- domain for redirect uri (https://freedns.afraid.org for free subdomains)

### Install and run
Run `npm i && sh deploy.sh` then choose whether you want to run for production or development (`npm start`/`npm run dev`)

### Config
Run `cp .env.example .env` then fill in all required values in `.env`

## Commands

`/sendverificationembed title:whatever description:whatever role:@role webhookurl:optional`

Creates a verification embed that users can click to verify for that specific role.
