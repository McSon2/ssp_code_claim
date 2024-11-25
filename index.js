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
  "@BonusCodesStake",
  "@ssptestcode",
  "@StakeKickCodes",
];

const normalizedChannelUsernames = channelUsernames.map((username) =>
  username.replace("@", "").toLowerCase()
);

let channelIdMap = new Map(); // Map pour stocker les IDs des canaux

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
        const entity = await telegramClient.getEntity(channelUsername);
        if (entity.id) {
          channelIdMap.set(
            entity.id.toString(),
            channelUsername.replace("@", "").toLowerCase()
          );
        }
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
  let messageText = message.message || message.text || message.caption || "";
  if (message.entities) {
    message.entities.forEach((entity) => {
      if (entity.type === "text_link") {
        const linkText = messageText.substr(entity.offset, entity.length);
        messageText += `\n${linkText}: ${entity.url}`;
      }
    });
  }
  return messageText;
}

function sendMessageToClients(messageData) {
  console.log("Envoi des données aux clients via WebSocket :", messageData);
  connectedClients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(messageData));
    }
  });
}

// Nouvelle fonction pour extraire les données du code
function extractCodeData(messageText) {
  let code = null;
  let value = null;
  let requirement = null;

  // Supprimer les espaces inutiles et normaliser les retours à la ligne
  messageText = messageText.trim().replace(/\r\n/g, "\n");

  // Diviser le message en lignes pour faciliter l'analyse
  const lines = messageText.split("\n");

  for (const line of lines) {
    // Vérifier si la ligne contient "Code:"
    let codeMatch = line.match(/Code:\s*([\S]+)/i);
    if (codeMatch) {
      code = codeMatch[1];
      continue;
    }

    // Vérifier si la ligne contient "Value:"
    let valueMatch = line.match(/Value:\s*(.+)/i);
    if (valueMatch) {
      value = valueMatch[1];
      continue;
    }

    // Vérifier si la ligne contient "Requirement:"
    let requirementMatch = line.match(/Requirement:\s*(.+)/i);
    if (requirementMatch) {
      requirement = requirementMatch[1];
      continue;
    }

    // Si aucune correspondance et que le code n'est pas encore défini, supposer que la ligne est le code
    if (!code && line.trim().length > 0) {
      code = line.trim();
    }
  }

  return {
    code: code || null,
    value: value || null,
    requirement: requirement || null,
  };
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
          normalizedChannelUsernames.includes(
            senderUsername.replace("@", "").toLowerCase()
          )
        ) {
          const messageText = processMessageEntities(message);

          // Extraire les données du code
          const extractedData = extractCodeData(messageText);

          const messageData = {
            text: messageText,
            from: senderUsername,
            date: message.date,
            channel: senderUsername,
            code: extractedData.code,
            value: extractedData.value,
            requirement: extractedData.requirement,
          };

          // Log des données envoyées au WebSocket
          console.log("Données envoyées au WebSocket :", messageData);

          sendMessageToClients(messageData);
        }
      } catch (error) {
        console.error("Erreur lors de getEntity :", error);
        if (error.message.includes("Could not find the input entity")) {
          let senderUsername = null;
          let channelId = null;

          if (message.peerId.channelId) {
            channelId = message.peerId.channelId.toString();
            senderUsername =
              channelIdMap.get(channelId) || `channel_${channelId}`;
          } else if (message.peerId.userId) {
            senderUsername = `user_${message.peerId.userId}`;
          }

          if (
            senderUsername &&
            (normalizedChannelUsernames.includes(
              senderUsername.replace("@", "").toLowerCase()
            ) ||
              channelIdMap.has(channelId))
          ) {
            const messageText = processMessageEntities(message);

            if (messageText) {
              // Extraire les données du code
              const extractedData = extractCodeData(messageText);

              const messageData = {
                text: messageText,
                from: senderUsername,
                date: message.date,
                channel: senderUsername,
                code: extractedData.code,
                value: extractedData.value,
                requirement: extractedData.requirement,
              };

              // Log des données envoyées au WebSocket
              console.log("Données envoyées au WebSocket :", messageData);

              sendMessageToClients(messageData);
            }
          }
        } else {
          console.error("Erreur lors du traitement du message :", error);
        }
      }
    } else {
      console.log("Message ou peerId manquant.");
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
