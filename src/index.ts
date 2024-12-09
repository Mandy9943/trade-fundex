import { World, e, envChain } from "xsuite";

import { ProxyNetworkProvider } from "@multiversx/sdk-network-providers/out";
import axios from "axios";
import BigNumber from "bignumber.js";
import dotenv from "dotenv";
import fs from "fs";
import TelegramBot from "node-telegram-bot-api";
import path from "path";
import bondingAbi from "./abi/bonding.abi.json";
import masterAbi from "./abi/master.abi.json";
import { scQuery } from "./query";
// Load environment variables
dotenv.config();

// Check if initial swap transaction has occurred
export const checkInitialSwapTransactions = async (
  receiverAddress: string,
  tokenId: string
): Promise<number> => {
  const api = axios.create({ baseURL: "https://api.multiversx.com" }); // Adjust if needed
  try {
    const { data } = await api.get<number>(
      `/transactions/count?receiver=${receiverAddress}&token=${tokenId}&status=success&function=initialSwap`
    );
    return data;
  } catch (error) {
    console.error("Error checking transaction count:", error);
    throw error;
  }
};

interface CommandPayload {
  token: string;
  amount?: number;
  slippage?: number;
  trailingPercent?: number;
}

interface SwapParams {
  address: string;
  tokenToSend: string;
  amountToSend: number;
  minAmountToReceive: number;
  tokenToReceive: string;
}

interface TokenMetadata {
  first_token_id: string;
  second_token_id: string;
  address: string;
}

// Track token states
type TokenState = "notTried" | "buying" | "waitingInitialSwap" | "acquired";

interface TrailingStopConfig {
  token: string;
  trailingPercent: number;
  slippage: number;
  initialPrice?: BigNumber;
  highestPrice?: BigNumber;
  active: boolean;
}

interface BotState {
  knownTokens: TokenMetadata[];
  tokenStatus: Record<string, TokenState>;
  trailingStops: { [token: string]: TrailingStopConfig };
}

interface BotConfig {
  buyCheckInterval: number; // in milliseconds
  buyTimeout: number; // in milliseconds
}

export class BONKBot {
  private bot: TelegramBot;
  private adminChatId: number = 709820730;
  private api = axios.create({ baseURL: "https://api.multiversx.com" });
  private provider = new ProxyNetworkProvider(
    "https://gateway.multiversx.com",
    { timeout: 10000 }
  );

  private masterContractAddress =
    "erd1qqqqqqqqqqqqqpgqg0sshhkwaxz8fxu47z4svrmp48mzydjlptzsdhxjpd";
  private masterAbi: any = masterAbi;
  private tokenAbi: any = bondingAbi;

  private world: World;

  // Store known tokens and their states
  private knownTokens: TokenMetadata[] = [];
  private tokenStatus: Record<string, TokenState> = {};
  private buyAttempts: Record<string, number> = {};

  // Trailing stops configuration
  private trailingStops: { [token: string]: TrailingStopConfig } = {};

  private pollingInterval: NodeJS.Timeout | undefined;

  private readonly stateFilePath = path.join(
    __dirname,
    "../data/bot-state.json"
  );

  private config: BotConfig = {
    buyCheckInterval: 60_000, // Check every 1 minute
    buyTimeout: 2 * 55_000, // 5 minutes timeout
  };

  private lastBuyTimestamps: Record<string, number> = {};

  constructor(private telegramToken: string) {
    this.world = World.new({ chainId: envChain.id() });
    console.log(`Using wallet: ${this.loadWallet().toString()}`);
    console.log(`Using chain: ${envChain.id()}`);

    // Ensure data directory exists
    const dataDir = path.dirname(this.stateFilePath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // Load saved state
    this.loadState();

    this.bot = new TelegramBot(this.telegramToken, { polling: true });
    this.initializeCommands();
    this.startMonitoring();
  }

  private loadWallet() {
    return this.world.newWalletFromFile_unsafe(
      "wallet.json",
      process.env.WALLET_PASSWORD!
    );
  }

  private async swapToken(params: SwapParams) {
    const wallet = this.loadWallet();

    const result = await wallet.callContract({
      callee: params.address,
      gasLimit: 10_000_000,
      funcName: "swap",
      esdts: [
        {
          amount: Math.floor(params.amountToSend),
          nonce: 0,
          id: params.tokenToSend,
        },
      ],
      funcArgs: [e.Str(params.tokenToReceive), e.U(params.minAmountToReceive)],
    });

    return result;
  }

  private async handleBuy(
    chatId: number,
    payload: CommandPayload
  ): Promise<void> {
    this.bot.sendMessage(
      chatId,
      `🔍 Processing buy order for token: ${payload.token}...`
    );
    try {
      await this.attemptBuy(chatId, payload, 5);
    } catch (error: any) {
      console.error("Error in handleBuy:", error.message);
      this.bot.sendMessage(
        chatId,
        `❌ Buy transaction failed: ${error.message}`
      );
    }
  }

  private async handleSell(
    chatId: number,
    payload: CommandPayload
  ): Promise<void> {
    try {
      this.bot.sendMessage(
        chatId,
        `🔍 Processing sell order for token: ${payload.token}...`
      );

      const contractAddress = await this.findContractAddress(payload.token);
      this.bot.sendMessage(
        chatId,
        `✅ Found trading contract: ${contractAddress.slice(
          0,
          8
        )}...${contractAddress.slice(-4)}`
      );

      const wallet = this.loadWallet().toString();
      const response = await this.api.get(`/accounts/${wallet}/tokens`);
      const tokenBalance = response.data.find(
        (token: any) => token.identifier === payload.token
      );

      if (!tokenBalance) {
        throw new Error(`Token ${payload.token} not found in wallet`);
      }

      const amountToSell = payload.amount
        ? new BigNumber(payload.amount).times(10 ** tokenBalance.decimals)
        : new BigNumber(tokenBalance.balance).times(0.98);

      if (amountToSell.isNaN() || amountToSell.isLessThanOrEqualTo(0)) {
        throw new Error("Invalid amount calculated");
      }

      this.bot.sendMessage(
        chatId,
        `💫 Submitting transaction to blockchain...`
      );

      const result = await this.swapToken({
        address: contractAddress,
        tokenToSend: payload.token,
        amountToSend: amountToSell.toNumber(),
        minAmountToReceive: new BigNumber(1).toNumber(),
        tokenToReceive: "ONE-f9954f",
      });

      // Update token status after successful sell
      this.tokenStatus[payload.token] = "notTried";
      this.saveState();

      const txUrl =
        result.explorerUrl || "Transaction submitted (URL not available)";
      this.bot.sendMessage(
        chatId,
        `✅ Transaction successful!\n\nView on explorer: ${txUrl}`
      );
    } catch (error: any) {
      console.error("Error in sellToken:", error.message);
      this.bot.sendMessage(chatId, `❌ Transaction failed: ${error.message}`);
    }
  }

  private async findContractAddress(tokenId: string): Promise<string> {
    try {
      const result = await scQuery(
        this.masterContractAddress,
        this.masterAbi,
        "getAllBondingMetadata"
      );

      const data = result.firstValue?.valueOf().map((item: any) => ({
        first_token_id: item.first_token_id,
        second_token_id: item.second_token_id,
        address: item.address.bech32(),
      }));

      const matchingContract = data.find(
        (contract: any) => contract.first_token_id === tokenId
      );

      if (!matchingContract) {
        throw new Error(`No contract found for token ${tokenId}`);
      }

      return matchingContract.address;
    } catch (error: any) {
      console.error("Error finding contract address:", error);
      throw new Error(
        `Failed to find contract for token ${tokenId}: ${error.message}`
      );
    }
  }

  // Attempts to buy a token up to `maxRetries` times. If all fail, waits for initial swap, then tries again.
  private async attemptBuy(
    chatId: number,
    payload: CommandPayload,
    maxRetries = 5
  ): Promise<void> {
    let attempt = 0;
    let lastError: Error | null = null;
    const tokenId = payload.token;

    // Set initial status if not set
    if (!this.tokenStatus[tokenId]) {
      this.tokenStatus[tokenId] = "notTried";
    }

    // Update status to buying
    this.tokenStatus[tokenId] = "buying";
    this.saveState();

    this.buyAttempts[tokenId] = 0;

    const contractAddress = await this.findContractAddress(tokenId);
    this.bot.sendMessage(
      chatId,
      `✅ Found trading contract: ${contractAddress.slice(
        0,
        8
      )}...${contractAddress.slice(-4)}
      
      On fundex: https://fundex.fun/degen/pair/${contractAddress}
      `
    );

    const wallet = this.loadWallet().toString();
    const tokenToSend = "ONE-f9954f"; // main token to buy with

    const response = await this.api.get(`/accounts/${wallet}/tokens`);
    const tokenBalance = response.data.find(
      (token: any) => token.identifier === tokenToSend
    );

    if (!tokenBalance) {
      throw new Error(`Token ${tokenToSend} not found in wallet`);
    }

    // amountToPay in 10**18
    const amountToPay = payload.amount
      ? new BigNumber(payload.amount).times(10 ** 18)
      : new BigNumber(tokenBalance.balance).times(0.01); // Buy a small amount for initial attempt?

    if (amountToPay.isNaN() || amountToPay.isLessThanOrEqualTo(0)) {
      throw new Error("Invalid amount calculated for buy");
    }

    while (attempt < maxRetries) {
      attempt++;
      this.buyAttempts[tokenId] = attempt;
      try {
        this.bot.sendMessage(
          chatId,
          `💫 (Attempt ${attempt}/${maxRetries}) Submitting transaction to buy ${tokenId}...`
        );

        const result = await this.swapToken({
          address: contractAddress,
          tokenToSend,
          amountToSend: amountToPay.toNumber(),
          minAmountToReceive: new BigNumber(1).toNumber(),
          tokenToReceive: tokenId,
        });

        // Update status on successful buy
        this.tokenStatus[tokenId] = "acquired";
        this.saveState();

        const txUrl =
          result.explorerUrl || "Transaction submitted (URL not available)";
        this.bot.sendMessage(
          chatId,
          `✅ Buy transaction successful!\n\nView on explorer: ${txUrl}`
        );
        return; // If successful, exit function
      } catch (error: any) {
        console.error(
          `Buy attempt ${attempt} for ${tokenId} failed:`,
          error.message
        );
        lastError = error as Error;
      }
    }

    // Update status when all attempts fail
    this.tokenStatus[tokenId] = "waitingInitialSwap";
    this.saveState();

    // Wait until initial swap occurs
    await this.waitForInitialSwap(chatId, tokenId, contractAddress);

    // Once initial swap is detected, attempt buy again
    this.bot.sendMessage(
      chatId,
      `🔄 Initial swap detected! Trying to buy ${tokenId} again...`
    );
    await this.attemptBuy(chatId, payload, 5);
  }

  // Automatic attempt to buy newly discovered tokens (without user command)
  private async attemptAutoBuy(tokenId: string, maxRetries = 5) {
    this.bot.sendMessage(
      this.adminChatId,
      `🔍 New token discovered: ${tokenId}, attempting initial buy...`
    );
    await this.attemptBuy(
      this.adminChatId,
      { token: tokenId, amount: 0.001 },
      maxRetries
    );
  }

  private async waitForInitialSwap(
    chatId: number,
    tokenId: string,
    contractAddress: string
  ) {
    this.bot.sendMessage(
      chatId,
      `⏳ Waiting for initial swap transactions for ${tokenId}...`
    );

    let interval: NodeJS.Timeout;
    return new Promise<void>((resolve) => {
      interval = setInterval(async () => {
        try {
          const swapCount = await checkInitialSwapTransactions(
            contractAddress,
            tokenId
          );
          if (swapCount > 0) {
            clearInterval(interval);
            this.bot.sendMessage(
              chatId,
              `✅ Initial swap detected for ${tokenId}, now tradable.`
            );
            resolve();
          }
        } catch (err) {
          console.error("Error checking initial swap:", err);
          // Continue polling despite errors
        }
      }, 15000); // Check every 15 seconds
    });
  }

  private initializeCommands() {
    this.bot.onText(/\/start/, (msg) => {
      this.bot.sendMessage(msg.chat.id, "Hello! I am BONKBot, ready to trade!");
    });

    this.bot.onText(/\/buy (.+) (.+)/, async (msg, match) => {
      const chatId = msg.chat.id;
      const token = match?.[1]?.trim();
      const amount = match?.[2]?.trim();

      if (!token || !amount) {
        return this.bot.sendMessage(chatId, "Usage: /buy TOKEN AMOUNT");
      }

      await this.handleBuy(chatId, { token, amount: parseFloat(amount) });
    });

    this.bot.onText(/\/sell (.+) (.+)/, async (msg, match) => {
      const chatId = msg.chat.id;
      const token = match?.[1]?.trim();
      const amount = match?.[2]?.trim();

      if (!token || !amount) {
        return this.bot.sendMessage(chatId, "Usage: /sell TOKEN AMOUNT");
      }

      await this.handleSell(chatId, { token, amount: parseFloat(amount) });
    });

    this.bot.onText(/\/setstop (.+) (.+) (.+)/, async (msg, match) => {
      const chatId = msg.chat.id;
      const token = match?.[1]?.trim();
      const trailingPercent = parseFloat(match?.[2]?.trim() || "0");
      const slippage = parseFloat(match?.[3]?.trim() || "0");

      if (!token || isNaN(trailingPercent) || isNaN(slippage)) {
        return this.bot.sendMessage(
          chatId,
          "Usage: /setstop TOKEN TRAILING_PERCENT SLIPPAGE"
        );
      }

      this.trailingStops[token] = {
        token,
        trailingPercent,
        slippage,
        active: true,
      };

      this.bot.sendMessage(
        chatId,
        `✅ Trailing stop set for ${token} at ${trailingPercent}% below the peak price.`
      );
    });

    this.bot.onText(/\/status (.+)/, async (msg, match) => {
      const chatId = msg.chat.id;
      const token = match?.[1]?.trim();
      if (!token) {
        return this.bot.sendMessage(chatId, "Usage: /status TOKEN");
      }

      if (!this.trailingStops[token]) {
        return this.bot.sendMessage(
          chatId,
          `No trailing stop configured for ${token}.`
        );
      }

      const config = this.trailingStops[token];
      const highestPrice = config.highestPrice?.toString() || "N/A";

      this.bot.sendMessage(
        chatId,
        `Status for ${token}:
- Trailing %: ${config.trailingPercent}%
- Slippage: ${config.slippage}%
- Highest Recorded Price: ${highestPrice}
- Active: ${config.active}`
      );
    });

    this.bot.onText(/\/tokens/, async (msg) => {
      const chatId = msg.chat.id;
      const statusList = Object.entries(this.tokenStatus)
        .map(([token, status]) => `${token}: ${status}`)
        .join("\n");

      if (statusList.length === 0) {
        this.bot.sendMessage(chatId, "No tokens are currently being tracked.");
      } else {
        this.bot.sendMessage(chatId, `Current token statuses:\n${statusList}`);
      }
    });
  }

  private async checkRecentBuys(tokenId: string): Promise<boolean> {
    try {
      // Check if the contract address is already known
      const knownToken = this.knownTokens.find(
        (token) => token.first_token_id === tokenId
      );
      if (!knownToken) {
        console.error(
          `Contract address for token ${tokenId} not found in known tokens.`
        );
        return false;
      }
      const contractAddress = knownToken.address;

      console.log(`[${new Date().toISOString()}] Checking buys for ${tokenId}`);
      console.log(`Contract Address: ${contractAddress}`);
      console.log(
        `Last Buy Timestamp: ${this.lastBuyTimestamps[tokenId] || "Never"}`
      );

      const response = await this.api.get(`/transactions`, {
        params: {
          receiver: contractAddress,
          token: "ONE-f9954f",
          status: "success",
          function: "swap",
          after: this.lastBuyTimestamps[tokenId] || 0,
        },
      });

      const transactions = response.data;
      console.log(`Found ${transactions.length} buy transactions`);

      if (transactions.length > 0) {
        this.lastBuyTimestamps[tokenId] = Date.now();
        console.log(
          `Updated last buy timestamp to: ${new Date(
            this.lastBuyTimestamps[tokenId]
          ).toISOString()}`
        );
        return true;
      }
      return false;
    } catch (error) {
      console.error(`Error checking recent buys for ${tokenId}:`, error);
      return false;
    }
  }

  private async monitorTokenBuysAndSellIfIdle() {
    console.log("\n=== Starting Buy Monitor Check ===");
    console.log("Current Token States:");
    console.log(JSON.stringify(this.tokenStatus, null, 2));
    console.log("\nLast Buy Timestamps:");
    console.log(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(this.lastBuyTimestamps).map(([token, timestamp]) => [
            token,
            new Date(timestamp).toISOString(),
          ])
        ),
        null,
        2
      )
    );

    for (const token in this.tokenStatus) {
      console.log(`\n🔍 Checking token: ${token}`);
      console.log(`Current status: ${this.tokenStatus[token]}`);

      if (this.tokenStatus[token] !== "acquired") {
        console.log(`Skipping ${token} - not in acquired state`);
        continue;
      }

      const hasRecentBuys = await this.checkRecentBuys(token);
      console.log(`Recent buys found: ${hasRecentBuys}`);

      if (!hasRecentBuys) {
        const lastBuyTime = this.lastBuyTimestamps[token] || 0;
        const timeSinceLastBuy = Date.now() - lastBuyTime;
        console.log(`Time since last buy: ${timeSinceLastBuy / 1000} seconds`);

        if (timeSinceLastBuy > this.config.buyTimeout) {
          console.log(
            `⚠️ No buys for ${token} in the last ${
              this.config.buyTimeout / 1000
            } seconds. Initiating sell...`
          );
          await this.handleSell(this.adminChatId, { token });
          console.log(`✅ Sell completed for ${token}`);
        } else {
          console.log(
            `Waiting for timeout - ${
              (this.config.buyTimeout - timeSinceLastBuy) / 1000
            } seconds remaining`
          );
        }
      }
    }
    console.log("\n=== Buy Monitor Check Complete ===\n");
  }

  private startMonitoring() {
    this.discoverNewTokens();
    setInterval(() => this.discoverNewTokens(), 60_000);

    setInterval(
      () => this.monitorTokenBuysAndSellIfIdle(),
      this.config.buyCheckInterval
    );
  }

  private async discoverNewTokens() {
    try {
      const result = await scQuery(
        this.masterContractAddress,
        this.masterAbi,
        "getAllBondingMetadata"
      );

      const data: TokenMetadata[] =
        result.firstValue?.valueOf().map((item: any) => ({
          first_token_id: item.first_token_id,
          second_token_id: item.second_token_id,
          address: item.address.bech32(),
        })) || [];

      const lastToken = data[data.length - 1];

      if (
        !this.knownTokens.find(
          (kt) => kt.first_token_id === lastToken.first_token_id
        )
      ) {
        // Update known tokens
        this.knownTokens.push(lastToken);

        // Set up trailing stop for the new token
        const tokenId = lastToken.first_token_id;
        this.trailingStops[tokenId] = {
          token: tokenId,
          trailingPercent: 10, // 10% trailing stop
          slippage: 25, // 25% slippage
          active: true,
        };
        console.log(`Trailing stop configured for new token ${tokenId}`);

        // Save state after modifications
        this.saveState();
      } else {
        return;
      }

      console.log("known tokens", this.knownTokens);
      console.log("last token", lastToken);

      // For each new token, attempt to buy if not tried
      const tokenId = lastToken.first_token_id;
      if (!this.tokenStatus[tokenId]) {
        this.tokenStatus[tokenId] = "notTried";
        this.saveState();
        // Attempt initial buy
        this.attemptAutoBuy(tokenId, 5).catch((err) =>
          console.error(`Error attempting auto-buy for ${tokenId}:`, err)
        );
      }
    } catch (error) {
      console.error("Error discovering new tokens:", error);
    }
  }

  private async getMarketCap(contractAddress: string): Promise<BigNumber> {
    try {
      console.log("contractAddress", contractAddress);

      const result = await scQuery(
        contractAddress,
        this.tokenAbi,
        "getMarketCap"
      );
      const marketCap = result.firstValue?.valueOf().toString();
      console.log("marketCap", marketCap.toString());
      return marketCap;
    } catch (error) {
      console.error("Error fetching market cap:", error);
      return new BigNumber(0);
    }
  }

  private async monitorPricesAndStopLosses() {
    console.log("trailingStops", this.trailingStops);

    for (const token in this.trailingStops) {
      const config = this.trailingStops[token];
      if (!config.active) continue;

      // Only monitor if we acquired this token (we hold it)
      if (this.tokenStatus[token] !== "acquired") continue;

      try {
        const contractAddress = await this.findContractAddress(token);
        const currentPrice = await this.getMarketCap(contractAddress);
        console.log("currentPrice", currentPrice);

        if (!config.highestPrice || currentPrice.gt(config.highestPrice)) {
          // New high, adjust highest price
          config.highestPrice = currentPrice;
        }

        if (config.highestPrice) {
          const triggerPrice = config.highestPrice.times(
            1 - config.trailingPercent / 100
          );
          if (currentPrice.lt(triggerPrice)) {
            // Price dropped below trigger
            console.log(
              `Trailing stop triggered for ${token}. Current: ${currentPrice}, Trigger: ${triggerPrice}`
            );

            const chatId = 123456789; // Use a default chatID or store user chat IDs somewhere
            this.bot.sendMessage(
              chatId,
              `🔴 Trailing stop triggered for ${token}. Executing sell...`
            );
            // Sell 50% of holdings as an example
            await this.handleSell(chatId, { token, amount: 0.5 });
            config.active = false;
            // Save state after modifying trailing stops
            this.saveState();
            this.bot.sendMessage(
              chatId,
              `✅ Trailing stop sell completed for ${token}.`
            );
          }
        }
      } catch (error) {
        console.error(`Error in trailing stop loop for ${token}:`, error);
      }
    }
  }

  private loadState(): void {
    try {
      if (fs.existsSync(this.stateFilePath)) {
        const savedState = JSON.parse(
          fs.readFileSync(this.stateFilePath, "utf8")
        ) as BotState;
        this.knownTokens = savedState.knownTokens;
        this.tokenStatus = savedState.tokenStatus;
        this.trailingStops = savedState.trailingStops;
        console.log("State loaded successfully");
      }
    } catch (error) {
      console.error("Error loading state:", error);
      // Initialize with empty state if load fails
      this.knownTokens = [];
      this.tokenStatus = {};
      this.trailingStops = {};
    }
  }

  private saveState(): void {
    try {
      const state: BotState = {
        knownTokens: this.knownTokens,
        tokenStatus: this.tokenStatus,
        trailingStops: this.trailingStops,
      };
      fs.writeFileSync(this.stateFilePath, JSON.stringify(state, null, 2));
    } catch (error) {
      console.error("Error saving state:", error);
    }
  }
}

// Instantiate the bot
const telegramToken = process.env.TELEGRAM_BOT_TOKEN!;
const botInstance = new BONKBot(telegramToken);
