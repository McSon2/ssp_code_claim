
require("dotenv").config();
const express = require("express");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const WebSocket = require("ws");

const app = express();

const apiId = parseInt(process.env.TELEGRAM_API_ID, 10);
const apiHash = process.env.TELEGRAM_API_HASH;
const sessionString = process.env.TELEGRAM_SESSION;

let telegramClient;
let telegramInitialized = false;

const wss = new WebSocket.Server({ noServer: true });
const connectedClients = new Set();

wss.on("connection", (ws) => {
  connectedClients.add(ws);
  ws.on("close", () => {
    connectedClients.delete(ws);
  });
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`Serveur en écoute sur le port ${PORT}`);
});

server.on("upgrade", (request, socket, head) => {
  const pathname = request.url;
  if (pathname === "/ws") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

const channelUsernames = [
  "@stakebonusdrops",
  "@BonusDropStake",
  "@ssptestcode",
  "@StakeKickCodes",
];

const normalizedChannelUsernames = channelUsernames.map((username) =>
  username.replace("@", "")
);

initializeTelegram().then(() => {
  listenToChannels(channelUsernames);
});

async function initializeTelegram() {
  console.log("Initialisation de Telegram...");
  telegramClient = new TelegramClient(
    new StringSession(sessionString),
    apiId,
    apiHash,
    {
      connectionRetries: 5,
    }
  );
  try {
    await telegramClient.connect();
    console.log("Vous êtes connecté à Telegram avec la session pré-générée.");
    telegramInitialized = true;

    for (const channelUsername of channelUsernames) {
      try {
        await telegramClient.getEntity(channelUsername);
        console.log(`Entité mise en cache pour ${channelUsername}`);
      } catch (error) {
        console.error(
          `Impossible de mettre en cache l'entité pour ${channelUsername}:`,
          error
        );
      }
    }
  } catch (error) {
    console.error("Erreur lors de la connexion à Telegram :", error);
    telegramInitialized = false;
  }
}

function processMessageEntities(message) {
  let messageText = message.message || message.text || "";
  if (message.entities) {
    message.entities.forEach((entity) => {
      if (entity.className === "MessageEntityTextUrl") {
        const linkText = messageText.substr(entity.offset, entity.length);
        messageText += `\n${linkText}: ${entity.url}`;
      }
    });
  }
  return messageText;
}

function sendMessageToClients(messageData) {
  connectedClients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(messageData));
    }
  });
}

async function listenToChannels(channelUsernames) {
  if (!telegramInitialized) {
    await initializeTelegram();
  }

  if (!telegramInitialized) {
    console.error("Impossible d'initialiser Telegram. Vérifiez votre session.");
    return;
  }

  console.log(
    `Écoute des messages des canaux : ${channelUsernames.join(", ")}`
  );

  const { NewMessage } = require("telegram/events");

  async function handleNewMessage(event) {
    const message = event.message;
    if (message && message.peerId) {
      try {
        const sender = await telegramClient.getEntity(message.peerId);
        const senderUsername =
          sender.username ||
          sender.title ||
          `channel_${message.peerId.channelId}`;

        if (
          normalizedChannelUsernames.includes(senderUsername.replace("@", ""))
        ) {
          const messageText = processMessageEntities(message);

          console.log(
            `Nouveau message reçu du canal @${senderUsername}:\n${messageText}`
          );

          const messageData = {
            text: messageText,
            from: senderUsername,
            date: message.date,
            channel: senderUsername,
          };

          sendMessageToClients(messageData);
        }
      } catch (error) {
        if (error.message.includes("Could not find the input entity")) {
          console.log(
            "Impossible de récupérer l'entité pour ce message. Utilisation des informations disponibles."
          );
          const senderUsername = message.peerId.channelId
            ? `channel_${message.peerId.channelId}`
            : `user_${message.peerId.userId}`;

          if (
            normalizedChannelUsernames.includes(senderUsername.replace("@", ""))
          ) {
            const messageText = processMessageEntities(message);

            if (messageText) {
              console.log(
                `Nouveau message reçu du canal ${senderUsername}:\n${messageText}`
              );

              const messageData = {
                text: messageText,
                from: senderUsername,
                date: message.date,
                channel: senderUsername,
              };

              sendMessageToClients(messageData);
            }
          } else {
            console.log(
              `Message ignoré du canal non surveillé : ${senderUsername}`
            );
          }
        } else {
          console.error("Erreur lors du traitement du message :", error);
        }
      }
    }
  }

  telegramClient.addEventHandler(async (event) => {
    try {
      await handleNewMessage(event);
    } catch (error) {
      console.error("Erreur non gérée dans handleNewMessage:", error);
    }
  }, new NewMessage({}));
}

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

app.use((err, req, res, next) => {
  console.error("Erreur Express:", err.stack);
  res.status(500).send("Something broke!");
});