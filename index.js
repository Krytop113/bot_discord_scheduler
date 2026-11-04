require("dotenv").config();
const { Client, GatewayIntentBits, Events } = require("discord.js");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, (readyClient) => {
  console.log(`🤖 Logged in as ${readyClient.user.tag}`);
});

client.on(Events.MessageCreate, (message) => {
  if (message.author.bot) return; // Ignore messages from other bots

  if (message.content.toLowerCase() === "!ping") {
    message.reply("Pong! 🏓");
  }
});

client.login(process.env.DISCORD_TOKEN);