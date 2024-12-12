# FundDex Trading Bot

A automated trading bot for monitoring and trading tokens on FundDex.

## Features

- Monitors new token listings on FundDex every minute
- Automatically attempts to buy new tokens when discovered
- Monitors trading activity and implements sell strategies
- Telegram bot integration for monitoring and control

## How It Works

### Token Discovery
- Polls FundDex smart contract every minute using `getAllBondingMetadata` view
- Detects new token listings by comparing with previously known tokens
- Automatically saves newly discovered tokens

### Trading Strategy
1. **Buy Process**
   - Attempts to buy newly discovered tokens
   - Retries up to 5 times if initial buy fails
   - Waits for initial swap if token is not yet tradeable

2. **Monitoring**
   - Checks for new buys every `buyCheckInterval` (default: 1 minute)
   - Tracks trading activity for each held token
   - Implements trailing stop-loss functionality

3. **Sell Conditions**
   - Automatically sells if no new buys after `buyTimeout` (default: 5 minutes)
   - Executes sell when trailing stop-loss is triggered
   - Supports manual selling through Telegram commands

## Configuration

Key parameters can be adjusted in the bot configuration:
- `buyCheckInterval`: Frequency of buy activity checks (default: 60 seconds)
- `buyTimeout`: Time to wait before selling if no new buys (default: 300 seconds)
- Trailing stop-loss parameters can be set per token

## Commands

Available Telegram bot commands:
- `/buy <token> <amount>` - Buy specified amount of token
- `/sell <token> <amount>` - Sell specified amount of token
- `/setstop <token> <trailing%> <slippage%>` - Set trailing stop-loss
- `/status <token>` - Check token status
- `/tokens` - List all tracked tokens