const WebSocket = require('ws');
const axios = require('axios');
const express = require('express');

let ws; // WebSocket variable is now defined here but initialized later
const TELEGRAM_BOT_TOKEN = '6749322551:AAHc3phe54L6jjqIwrQjZ7VMreMSv0LbiWM';
const TELEGRAM_CHAT_ID = '-4275442556';

let devMints = {};
let isWebSocketActive = false; // Track if WebSocket is active

const app = express();
const port = process.env.PORT || 4000;

// Function to fetch SOL price from Binance API
async function fetchSolPrice() {
  try {
    const response = await axios.get('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT');
    return parseFloat(response.data.price);
  } catch (error) {
    console.error('Error fetching SOL price:', error);
    return null;
  }
}

// Function to subscribe to token trade for a given mint
function subscribeTokenTrade(mint) {
  const payload = {
    method: "subscribeTokenTrade",
    keys: [mint]
  };
  ws.send(JSON.stringify(payload));
}

// Function to subscribe to account trade for a given trader public key
function subscribeAccountTrade(traderPublicKey) {
  const payload = {
    method: "subscribeAccountTrade",
    keys: [traderPublicKey]
  };
  ws.send(JSON.stringify(payload));
}

// Function to send a message to Telegram
async function sendTelegramMessage(message) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const payload = {
    chat_id: TELEGRAM_CHAT_ID,
    text: message,
    parse_mode: 'Markdown' // Enable Markdown parsing
  };

  try {
    const response = await axios.post(url, payload);
    if (response.data.ok) {
      return response.data.result.message_id;
    } else {
      console.error('Failed to send message:', response.data);
    }
  } catch (error) {
    console.error('Error sending message:', error);
  }
}

// Function to delete a message from Telegram
async function deleteTelegramMessage(messageId) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteMessage`;
  const payload = {
    chat_id: TELEGRAM_CHAT_ID,
    message_id: messageId
  };

  try {
    const response = await axios.post(url, payload);
    if (!response.data.ok) {
      console.error('Failed to delete message:', response.data);
    }
  } catch (error) {
    console.error('Error deleting message:', error);
  }
}

// Function to check and delete messages if no new buy transactions within 3 minutes
function checkAndDeleteOldMessages() {
  const currentTime = Date.now();
  for (const mint in devMints) {
    const mintData = devMints[mint];
    if (mintData.devSold && mintData.lastBuyTime) {
      const timeSinceLastBuy = currentTime - mintData.lastBuyTime;
      if (timeSinceLastBuy >= 180000 && mintData.messageId) { // 180000 ms = 3 minutes
        deleteTelegramMessage(mintData.messageId);
        console.log(`Deleted message for mint: ${mint}`);
        delete devMints[mint]; // Remove the mint from tracking
      }
    }
  }
}

// Function to periodically check market caps for sent mints
async function checkMarketCaps() {
  const solPrice = await fetchSolPrice();
  if (solPrice === null) {
    console.error('Could not fetch SOL price. Skipping market cap check.');
    return;
  }

  for (const mint in devMints) {
    const mintData = devMints[mint];
    const marketCapUSDT = (mintData.marketCapSol * solPrice).toFixed(2);

    if (marketCapUSDT > 50000 && !mintData.cookedSent) {
      const message = `🔥 *COOKED* 🔥\n*Name:* ${mintData.name}\n*Ticker:* ${mintData.symbol}\n*Market Cap (USDT):* ${marketCapUSDT}\n[PUMPFUN](https://pump.fun/${mint})\n[BULLX](https://bullx.io/terminal?chainId=1399811149&address=${mint})`;
      sendTelegramMessage(message);
      console.log(message);
      mintData.cookedSent = true;
    }
  }
}

// Function to start the WebSocket connection
function startWebSocket() {
  ws = new WebSocket('wss://pumpportal.fun/api/data');

  ws.on('open', function open() {
    // Subscribing to token creation events
    const payload = {
      method: "subscribeNewToken",
    };
    ws.send(JSON.stringify(payload));
    console.log('WebSocket connection started');
  });

  ws.on('message', async function message(data) {
    const parsedData = JSON.parse(data);

    // Check if the message is about a new token creation
    if (parsedData.txType === 'create') {
      const mint = parsedData.mint;
      const traderPublicKey = parsedData.traderPublicKey;
      const name = parsedData.name;
      const symbol = parsedData.symbol;

      // Store the initial creator's public key for this mint
      devMints[mint] = {
        traderPublicKey,
        devSold: false,
        buyCount: 0,
        potentialCTOSent: false,
        highPotentialCTOSent: false,
        lastBuyTime: null,
        messageId: null,
        name,
        symbol,
        marketCapSol: parsedData.marketCapSol,
        cookedSent: false
      };

      // Subscribe to token trade and trader public key for the new token
      subscribeTokenTrade(mint);
      subscribeAccountTrade(traderPublicKey);

      console.log(`Subscribed to token trade for mint: ${mint}`);
      console.log(`Subscribed to account trade for trader: ${traderPublicKey}`);
    }

    // Check if the message is about a sell trade
    if (parsedData.txType === 'sell') {
      const mint = parsedData.mint;
      const traderPublicKey = parsedData.traderPublicKey;

      // If the trade is a sell transaction by the DEV, mark the mint as DEV sold
      if (devMints[mint] && devMints[mint].traderPublicKey === traderPublicKey) {
        devMints[mint].devSold = true;
        devMints[mint].buyCount = 0; // Reset buy count after DEV sells
        console.log(`DEV sold detected for mint: ${mint}`);
      }
    }

    // Check if the message is about a buy trade
    if (parsedData.txType === 'buy') {
      const mint = parsedData.mint;

      // If the DEV has sold and this is a buy transaction, increment the buy count
      if (devMints[mint] && devMints[mint].devSold) {
        devMints[mint].buyCount += 1;
        devMints[mint].lastBuyTime = Date.now(); // Update the last buy time
        console.log(`Buy transaction detected for mint: ${mint}. Buy count: ${devMints[mint].buyCount}`);
      
        // Immediate market cap check
        checkMarketCaps();

        // Fetch the SOL price
        const solPrice = await fetchSolPrice();
        if (solPrice === null) {
          console.error('Could not fetch SOL price. Skipping message send.');
          return;
        }
        const marketCapUSDT = (parsedData.marketCapSol * solPrice).toFixed(2);

        // If the buy count reaches 10-15 and potential CTO message not sent, send potential CTO message
        if (devMints[mint].buyCount >= 10 && devMints[mint].buyCount <= 15 && !devMints[mint].potentialCTOSent) {
          const message = `🚨 *Potential CTO* 🚨\n*Name:* ${devMints[mint].name}\n*Ticker:* ${devMints[mint].symbol}\n*Market Cap (USDT):* ${marketCapUSDT}\n[PUMPFUN](https://pump.fun/${mint})\n[BULLX](https://bullx.io/terminal?chainId=1399811149&address=${mint})`;
          sendTelegramMessage(message).then(messageId => {
            devMints[mint].messageId = messageId; // Store the message ID
          });
          console.log(message);
          devMints[mint].potentialCTOSent = true;
        }

        // If the buy count reaches 25-30 and high potential CTO message not sent, send high potential CTO message
        if (devMints[mint].buyCount >= 25 && devMints[mint].buyCount <= 30 && !devMints[mint].highPotentialCTOSent) {
          const message = `🟢 *HIGH POTENTIAL CTO* 🟢\n*Name:* ${devMints[mint].name}\n*Ticker:* ${devMints[mint].symbol}\n*Market Cap (USDT):* ${marketCapUSDT}\n[PUMPFUN](https://pump.fun/${mint})\n[BULLX](https://bullx.io/terminal?chainId=1399811149&address=${mint})`;
          sendTelegramMessage(message).then(messageId => {
            devMints[mint].messageId = messageId; // Store the message ID
          });
          console.log(message);
          devMints[mint].highPotentialCTOSent = true;
        }
      }
    }

    console.log(parsedData);
  });

  ws.on('error', function error(err) {
    console.error('WebSocket error:', err);
  });

  ws.on('close', function close() {
    console.log('WebSocket connection closed');
  });

  // Start checking for old messages and market caps
  setInterval(checkAndDeleteOldMessages, 60000); // 60000 ms = 1 minute
  setInterval(checkMarketCaps, 60000); // 60000 ms = 1 minute
}

// Function to stop the WebSocket connection
function stopWebSocket() {
  if (ws) {
    ws.close();
    ws = null;
    isWebSocketActive = false;
    console.log('WebSocket connection stopped');
  }
}

// Function to handle incoming Telegram messages
async function handleTelegramUpdate(update) {
  const message = update.message;
  if (!message || !message.text) return;

  const chatId = message.chat.id;
  const text = message.text.trim();

  if (chatId.toString() === TELEGRAM_CHAT_ID.trim()) {
    if (text === '/start' && !isWebSocketActive) {
      isWebSocketActive = true;
      sendTelegramMessage('WebSocket connection started');
      startWebSocket();
    } else if (text === '/stop' && isWebSocketActive) {
      sendTelegramMessage('WebSocket connection stopped');
      stopWebSocket();
    }
  }
}

// Function to check for Telegram updates (polling method)
async function checkTelegramUpdates() {
  let lastUpdateId = 0;

  setInterval(async () => {
    try {
      const response = await axios.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}`);
      const updates = response.data.result;

      for (const update of updates) {
        await handleTelegramUpdate(update);
        lastUpdateId = update.update_id;
      }
    } catch (error) {
      if (error.response && error.response.status === 409) {
        console.error('Another instance is running. Restarting the bot...');
        // Logic to restart the bot or wait and retry
      } else {
        console.error('Error fetching Telegram updates:', error);
      }
    }
  }, 1000); // Poll every second
}

// Start listening for Telegram updates
checkTelegramUpdates();

// Set up the HTTP server
app.get('/', (req, res) => {
  res.send('Bot is running');
});

app.listen(port, () => {
  console.log(`HTTP server listening on port ${port}`);
});
