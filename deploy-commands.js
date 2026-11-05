require("dotenv").config();
const { REST, Routes, SlashCommandBuilder } = require("discord.js");

const commands = [
  new SlashCommandBuilder()
    .setName("todo")
    .setDescription("Fitur manajemen daftar tugas server dengan deadline")
    .addSubcommand((sub) =>
      sub
        .setName("add")
        .setDescription("Tambah tugas baru dengan deadline & penanggung jawab")
        .addStringOption((opt) =>
          opt
            .setName("task")
            .setDescription("Deskripsi tugas")
            .setRequired(true),
        )
        .addStringOption((opt) =>
          opt
            .setName("deadline")
            .setDescription(
              "Format: YYYY-MM-DD HH:mm (Contoh: 2026-12-12 12:00)",
            )
            .setRequired(true),
        )
        .addUserOption((opt) =>
          opt
            .setName("penanggung_jawab")
            .setDescription(
              "Tag orang yang bertanggung jawab (opsional, default: kamu)",
            )
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("done")
        .setDescription(
          "Tampilkan daftar tugas kamu atau tandai tugas yang selesai",
        )
        .addIntegerOption((opt) =>
          opt
            .setName("nomor")
            .setDescription("Nomor urut tugas (opsional)")
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("summary")
        .setDescription("Cetak laporan ringkasan seluruh tugas server"),
    ),

  new SlashCommandBuilder()
    .setName("remind")
    .setDescription(
      "Kirim pengingat ringkasan To-Do dan deadline ke channel pengumuman",
    ),
].map((cmd) => cmd.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log("⚡ Memperbarui Slash Commands...");
    await rest.put(
      Routes.applicationGuildCommands(
        process.env.CLIENT_ID,
        process.env.GUILD_ID,
      ),
      { body: commands },
    );
    console.log("✅ Slash Commands berhasil diperbarui!");
  } catch (error) {
    console.error("❌ Gagal mendaftarkan command:", error);
  }
})();
