require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  Events,
  EmbedBuilder,
  MessageFlags,
  Options,
  AttachmentBuilder,
} = require("discord.js");
const cron = require("node-cron");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  // Optimasi RAM untuk Discloud (100MB limit)
  makeCache: Options.cacheWithLimits({
    MessageManager: 0,
    PresenceManager: 0,
    ReactionManager: 0,
    ThreadManager: 0,
  }),
});

const STORAGE_CHANNEL_ID = process.env.STORAGE_CHANNEL_ID;
const AUDIT_CHANNEL_ID = process.env.AUDIT_CHANNEL_ID;
const SUMMARY_CHANNEL_ID = process.env.SUMMARY_CHANNEL_ID;

let state = {
  todos: {}, // Key: "guildId:userId" => Array of { id, task, deadlineTimestamp, assigneeId, createdBy, createdAt }
  reminders: [],
};

let masterMessageId = null;

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

async function saveState() {
  try {
    const storageChannel = await client.channels.fetch(STORAGE_CHANNEL_ID);
    if (!storageChannel) return;

    const jsonBuffer = Buffer.from(JSON.stringify(state, null, 2), "utf8");
    const attachment = new AttachmentBuilder(jsonBuffer, {
      name: "state.json",
    });

    if (masterMessageId) {
      try {
        const msg = await storageChannel.messages.fetch(masterMessageId);
        await msg.edit({
          content: "💾 **Database State (Attachment)**",
          files: [attachment],
        });
        return;
      } catch (err) {
        console.warn("Pesan master tidak ditemukan, membuat pesan baru...");
      }
    }

    const newMsg = await storageChannel.send({
      content: "💾 **Database State (Attachment)**",
      files: [attachment],
    });
    masterMessageId = newMsg.id;
  } catch (err) {
    console.error("❌ Gagal menyimpan state:", err);
  }
}

async function logAudit(action, detail, user) {
  try {
    const auditChannel = await client.channels.fetch(AUDIT_CHANNEL_ID);
    if (!auditChannel) return;

    const embed = new EmbedBuilder()
      .setTitle(`📋 Audit Log: ${action}`)
      .setDescription(detail)
      .addFields({
        name: "Eksekutor",
        value: `${user.tag || user.username} (${user.id})`,
        inline: true,
      })
      .setTimestamp()
      .setColor(
        action.includes("EXPIRED") ||
          action.includes("SELESAI") ||
          action.includes("HAPUS")
          ? 0xff4d4d
          : 0x4d94ff,
      );

    await auditChannel.send({ embeds: [embed] });
  } catch (err) {
    console.error("❌ Gagal merilis audit log:", err);
  }
}

function formatDate(timestamp) {
  const d = new Date(timestamp);
  return d.toLocaleString("id-ID", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function purgeExpiredTodos() {
  const now = Date.now();
  let purgedCount = 0;

  for (const storeKey in state.todos) {
    const initialLength = state.todos[storeKey].length;
    state.todos[storeKey] = state.todos[storeKey].filter(
      (item) => item.deadlineTimestamp > now,
    );
    purgedCount += initialLength - state.todos[storeKey].length;
  }

  if (purgedCount > 0) {
    await saveState();
    await logAudit(
      "AUTO-PURGE EXPIRED TODO",
      `Sistem menghapus otomatis **${purgedCount} tugas** yang telah melewati deadline.`,
      client.user,
    );
  }
}

// Generate Embed Ringkasan Server dengan Penanggung Jawab
async function generateSummaryEmbed(guildId) {
  const now = Date.now();
  let allGuildTodos = [];

  for (const storeKey in state.todos) {
    if (storeKey.startsWith(`${guildId}:`)) {
      state.todos[storeKey].forEach((t) => {
        if (t.deadlineTimestamp > now) {
          allGuildTodos.push(t);
        }
      });
    }
  }

  if (allGuildTodos.length === 0) {
    return new EmbedBuilder()
      .setTitle("📢 Ringkasan To-Do & Deadline Server")
      .setDescription("🎉 Tidak ada tugas aktif yang terdaftar saat ini!")
      .setColor(0x00ff88)
      .setTimestamp();
  }

  // Urutkan tugas dari deadline terdekat ke paling jauh
  allGuildTodos.sort((a, b) => a.deadlineTimestamp - b.deadlineTimestamp);

  const formattedList = allGuildTodos
    .map((item, i) => {
      const assigneeMention = item.assigneeId
        ? `<@${item.assigneeId}>`
        : `<@${item.createdBy}>`;
      return `**${i + 1}. ${item.task}**\n   👤 Penanggung Jawab: ${assigneeMention}\n   ⏰ Deadline: \`${formatDate(item.deadlineTimestamp)}\``;
    })
    .join("\n\n");

  return new EmbedBuilder()
    .setTitle("📢 Ringkasan To-Do & Deadline Server (Urutan Terdekat)")
    .setDescription(formattedList)
    .setColor(0x4d94ff)
    .setFooter({
      text: "Tugas yang melewati deadline akan terhapus otomatis oleh sistem.",
    })
    .setTimestamp();
}

// Kirim Pengingat ke Channel Pengumuman
async function sendAnnouncementReminder(guildId) {
  await purgeExpiredTodos();
  const summaryChannel = await client.channels.fetch(SUMMARY_CHANNEL_ID);
  if (summaryChannel) {
    const embed = await generateSummaryEmbed(guildId);
    await summaryChannel.send({
      content: "🔔 **PENGINGAT PENGUMUMAN SERVER: DAFTAR TO-DO & DEADLINE**",
      embeds: [embed],
    });
    return true;
  }
  return false;
}

// =============================================================================
// BOT STARTUP & CRON JOBS (PENGINGAT BERKALA)
// =============================================================================

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`🤖 Bot Server Aktif sebagai: ${readyClient.user.tag}`);

  try {
    const storageChannel = await client.channels.fetch(STORAGE_CHANNEL_ID);
    const messages = await storageChannel.messages.fetch({ limit: 5 });
    const lastMsg = messages.first();

    if (lastMsg) {
      masterMessageId = lastMsg.id;

      // Kasus 1: State disimpan via File Attachment (Format Baru - Tanpa Batas 2000 Karakter)
      const attachment = lastMsg.attachments.first();
      if (attachment && attachment.name.endsWith(".json")) {
        const res = await fetch(attachment.url);
        state = await res.json();
        console.log("✅ Data state berhasil dimuat dari attachment file #bot-storage.");
      }
      // Kasus 2: Backward compatibility jika pesan lama masih berupa teks ```json ... ```
      else if (lastMsg.content.startsWith("```json")) {
        const jsonText = lastMsg.content.replace(/```json|```/g, "").trim();
        state = JSON.parse(jsonText);
        console.log("✅ Data state lama (teks) berhasil dimuat. Mengupgrade ke format file...");
        await saveState(); // Otomatis upgrade ke attachment
      } else {
        console.log("ℹ️ Belum ada state tersimpan. Membuat state awal...");
        await saveState();
      }
    } else {
      console.log("ℹ️ Channel storage kosong. Membuat state awal...");
      await saveState();
    }
  } catch (err) {
    console.error("❌ Gagal memuat state awal:", err);
  }

  // 1. Cron Auto-Purge: Mengecek & menghapus tugas kedaluwarsa setiap 1 menit
  cron.schedule("* * * * *", async () => {
    await purgeExpiredTodos();
  });

  // 2. Cron Pengingat Berkala Otomatis: Berjalan 2 kali sehari (Jam 08:00 Pagi & 17:00 Sore)
  // Format Cron: "menit jam * * *" -> "0 8,17 * * *"
  cron.schedule("0 8,17 * * *", async () => {
    try {
      if (process.env.GUILD_ID) {
        await sendAnnouncementReminder(process.env.GUILD_ID);
        console.log(
          "⏰ Pengingat berkala harian berhasil dikirim ke channel pengumuman.",
        );
      }
    } catch (err) {
      console.error("Gagal mengirim pengingat berkala harian:", err);
    }
  });
});

// =============================================================================
// INTERACTION HANDLER (/todo & /remind)
// =============================================================================

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, guildId, user } = interaction;
  const storeKey = `${guildId}:${user.id}`;

  if (!state.todos[storeKey]) {
    state.todos[storeKey] = [];
  }

  // -------------------------------------------------------------
  // COMMAND /todo
  // -------------------------------------------------------------
  if (commandName === "todo") {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === "add") {
      const task = interaction.options.getString("task");
      const deadlineStr = interaction.options.getString("deadline");
      const assigneeUser =
        interaction.options.getUser("penanggung_jawab") || user;

      const deadlineParsed = new Date(deadlineStr.replace(" ", "T"));
      if (
        isNaN(deadlineParsed.getTime()) ||
        deadlineParsed.getTime() <= Date.now()
      ) {
        return interaction.reply({
          content:
            "❌ Format deadline tidak valid atau sudah lewat! Gunakan format: `YYYY-MM-DD HH:mm` (Contoh: `2026-12-12 12:00`)",
          flags: MessageFlags.Ephemeral,
        });
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const todoObj = {
        id: Date.now().toString(),
        task,
        deadlineTimestamp: deadlineParsed.getTime(),
        assigneeId: assigneeUser.id,
        createdBy: user.id,
        createdAt: Date.now(),
      };

      state.todos[storeKey].push(todoObj);
      await saveState();
      await logAudit(
        "TAMBAH TODO",
        `Tugas: **"${task}"** | Penanggung Jawab: <@${assigneeUser.id}> | Deadline: \`${formatDate(todoObj.deadlineTimestamp)}\``,
        user,
      );

      await interaction.editReply({
        content: `✅ **Tugas Ditambahkan:** "${task}"\n👤 **Penanggung Jawab:** <@${assigneeUser.id}>\n⏰ **Deadline:** \`${formatDate(todoObj.deadlineTimestamp)}\``,
      });
    } else if (subcommand === "done") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await purgeExpiredTodos();

      const userTodos = state.todos[storeKey];

      if (userTodos.length === 0) {
        return interaction.editReply({
          content: "📋 Daftar tugas aktif kamu kosong!",
        });
      }

      userTodos.sort((a, b) => a.deadlineTimestamp - b.deadlineTimestamp);

      const nomor = interaction.options.getInteger("nomor");

      if (!nomor) {
        const listText = userTodos
          .map(
            (t, i) =>
              `**#${i + 1}** - ${t.task} (PJ: <@${t.assigneeId || t.createdBy}>, Deadline: \`${formatDate(t.deadlineTimestamp)}\`)`,
          )
          .join("\n");

        return interaction.editReply({
          content: `📋 **Daftar Tugas Kamu:**\n${listText}\n\n💡 *Ketik \`/todo done nomor: <angka>\` untuk menandai tugas yang selesai.*`,
        });
      }

      const index = nomor - 1;
      if (index < 0 || index >= userTodos.length) {
        return interaction.editReply({
          content:
            "❌ Nomor tugas tidak valid! Gunakan `/todo done` tanpa nomor untuk melihat daftar tugas kamu.",
        });
      }

      const [removedTask] = userTodos.splice(index, 1);
      await saveState();
      await logAudit(
        "SELESAI TODO",
        `Tugas selesai: **"${removedTask.task}"**`,
        user,
      );

      let replyContent = `🎉 Tugas **"${removedTask.task}"** selesai dan dihapus!\n`;
      if (userTodos.length > 0) {
        const remainingList = userTodos
          .map(
            (t, i) =>
              `**#${i + 1}** - ${t.task} (Deadline: \`${formatDate(t.deadlineTimestamp)}\`)`,
          )
          .join("\n");
        replyContent += `\n📋 **Sisa Tugas Kamu:**\n${remainingList}`;
      } else {
        replyContent += `\n✨ Semua tugas kamu sudah selesai!`;
      }

      await interaction.editReply({ content: replyContent });
    } else if (subcommand === "summary") {
      await interaction.deferReply();
      await purgeExpiredTodos();
      const embed = await generateSummaryEmbed(guildId);
      await interaction.editReply({ embeds: [embed] });
    }
  }

  // -------------------------------------------------------------
  // COMMAND /remind (Manual Pemicu ke Channel Pengumuman)
  // -------------------------------------------------------------
  if (commandName === "remind") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const success = await sendAnnouncementReminder(guildId);

    if (success) {
      await logAudit(
        "MANUAL REMINDER",
        "Pengingat pengumuman dikirim manual.",
        user,
      );
      await interaction.editReply({
        content: `🔔 Pengingat ringkasan To-Do & Deadline berhasil dikirim ke channel pengumuman <#${SUMMARY_CHANNEL_ID}>!`,
      });
    } else {
      await interaction.editReply({
        content:
          "❌ Gagal mengirim pengingat ke channel pengumuman. Periksa ID channel di `.env`.",
      });
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
