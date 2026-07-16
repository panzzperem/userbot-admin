/**
 * ═══════════════════════════════════════════════════════════
 *  🤖 PANZZSTORE TELEGRAM ADMIN USERBOT
 *  Userbot Telegram khusus admin untuk kirim invoice + QRIS,
 *  auto-responder pintar (FAQ/Gemini AI), dan anti-spam/block.
 * ═══════════════════════════════════════════════════════════
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const input = require('input');
const admin = require('firebase-admin');
const axios = require('axios');
const QRCode = require('qrcode');
const fs = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ═══════════════════════════════════════
// CONFIG & CONSTANTS
// ═══════════════════════════════════════
const apiId = parseInt(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const sessionString = process.env.TELEGRAM_SESSION || "";
const adminId = process.env.ADMIN_TELEGRAM_ID || "";
const storeName = process.env.STORE_NAME || "PanzzStore";

if (!apiId || !apiHash) {
  console.error("❌ ERROR: TELEGRAM_API_ID dan TELEGRAM_API_HASH harus diisi di file .env!");
  process.exit(1);
}

// ═══════════════════════════════════════
// FIREBASE CONNECTION
// ═══════════════════════════════════════
const serviceAccountPath = path.resolve(__dirname, '../serviceAccountKey.json');
if (!fs.existsSync(serviceAccountPath)) {
  console.error(`❌ ERROR: File service account firebase tidak ditemukan di ${serviceAccountPath}!`);
  process.exit(1);
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccountPath),
  });
}
const db = admin.firestore();

// ═══════════════════════════════════════
// STATE MANAGERS
// ═══════════════════════════════════════
// Simpan invoice aktif berdasarkan chatId (chatId -> invoice data)
const activeInvoices = new Map();
// Lacak history pesan masuk untuk mendeteksi spam (chatId -> array of timestamps)
const messageHistory = new Map();
// Lacak waktu auto-reply terakhir untuk cooldown (chatId -> timestamp)
const lastAutoReply = new Map();

// ═══════════════════════════════════════
// CUSTOMER BOT DETAILS DETECTOR
// ═══════════════════════════════════════
let customerBotUsername = "@autoorderbot"; // Default fallback
async function fetchCustomerBotUsername() {
  const token = process.env.BOT_TOKEN;
  if (!token) {
    console.log("ℹ️ BOT_TOKEN tidak ditemukan di root .env, menggunakan default @autoorderbot");
    return;
  }
  try {
    const res = await axios.get(`https://api.telegram.org/bot${token}/getMe`);
    if (res.data?.ok && res.data?.result?.username) {
      customerBotUsername = `@${res.data.result.username}`;
      console.log(`🤖 Customer Bot Username terdeteksi otomatis: ${customerBotUsername}`);
    }
  } catch (err) {
    console.warn("⚠️ Gagal mendeteksi username Customer Bot:", err.message);
  }
}

// ═══════════════════════════════════════
// GEMINI AI SETUP
// ═══════════════════════════════════════
let geminiModel = null;
if (process.env.GEMINI_API_KEY) {
  try {
    const ai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    geminiModel = ai.getGenerativeModel({ model: "gemini-2.5-flash" });
    console.log("🤖 Gemini AI Auto-Responder diaktifkan.");
  } catch (err) {
    console.error("⚠️ Gagal inisialisasi Gemini AI:", err.message);
  }
}

// ═══════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════
function formatIDR(amount) {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

function escapeHTML(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function generateOrderId() {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
  const random = Math.floor(Math.random() * 9000 + 1000);
  return `TG-${dateStr}-${random}`;
}

function getWIBTime() {
  return new Date().toLocaleString('id-ID', {
    timeZone: 'Asia/Jakarta',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }) + ' WIB';
}

async function createPakasirQRIS(orderId, amount) {
  try {
    const response = await axios.post(`https://app.pakasir.com/api/transactioncreate/qris`, {
      project: process.env.PAKASIR_PROJECT_NAME,
      order_id: orderId,
      amount: amount,
      api_key: process.env.PAKASIR_API_KEY
    });
    return response.data;
  } catch (error) {
    console.error('Pakasir API Error:', error.response?.data || error.message);
    return null;
  }
}

async function getStoreProductsContext() {
  try {
    const snapshot = await db.collection('products').get();
    if (snapshot.empty) {
      return "Saat ini tidak ada produk yang terdaftar di database toko.";
    }
    
    let contextStr = "Berikut adalah daftar produk, varian, harga, dan stok real-time di toko saat ini:\n";
    snapshot.forEach(doc => {
      const data = doc.data();
      if (data.isVisible === false) return;
      
      const productName = data.name || "Produk Tanpa Nama";
      contextStr += `* ${productName}:\n`;
      
      const variants = data.variants || [];
      if (variants.length === 0) {
        contextStr += `  - (Tidak ada varian terdaftar)\n`;
      } else {
        variants.forEach(v => {
          const label = v.label || "Varian Standar";
          const price = v.price ? formatIDR(v.price) : "Hubungi Admin";
          const resellerPrice = v.resellerPrice ? formatIDR(v.resellerPrice) : null;
          const stock = v.stock !== undefined ? v.stock : 0;
          
          let variantLine = `  - Varian: ${label} | Harga: ${price}`;
          if (resellerPrice) {
            variantLine += ` (Reseller: ${resellerPrice})`;
          }
          variantLine += ` | Stok: ${stock}`;
          contextStr += `${variantLine}\n`;
        });
      }
    });
    return contextStr;
  } catch (err) {
    console.error("Gagal mengambil data produk dari Firestore:", err.message);
    return "Gagal memuat produk real-time, silakan jawab secara umum dan arahkan untuk cek di bot utama.";
  }
}

// Predefined FAQ Keywords & Answers
const faqKeywords = {
  "ready": `<blockquote><b>🤖 ${storeName.toUpperCase()} FAQ</b>\n━━━━━━━━━━━━━━━━━━━━\nHalo kak! Semua produk digital yang tertera di katalog kami selalu ready stock. Silakan buat pesanan melalui bot utama kami di @autoorderbot atau tunggu respon admin untuk order manual ya.</blockquote>`,
  "harga": `<blockquote><b>🤖 ${storeName.toUpperCase()} FAQ</b>\n━━━━━━━━━━━━━━━━━━━━\nHalo kak! Daftar harga produk lengkap dan stok terbaru dapat diakses langsung melalui bot utama kami dengan mengetik /start di @autoorderbot.</blockquote>`,
  "bayar": `<blockquote><b>🤖 ${storeName.toUpperCase()} FAQ</b>\n━━━━━━━━━━━━━━━━━━━━\nKami menerima metode pembayaran otomatis QRIS (DANA, OVO, GoPay, ShopeePay, LinkAja). Admin juga bisa membuatkan tagihan QRIS manual langsung di chat ini jika Anda memesan manual.</blockquote>`,
  "qris": `<blockquote><b>🤖 ${storeName.toUpperCase()} FAQ</b>\n━━━━━━━━━━━━━━━━━━━━\nUntuk pembayaran QRIS manual, mohon tunggu admin mengirimkan invoice tagihan beserta QR code resmi. Jangan transfer ke QRIS lain selain yang dikirimkan oleh admin.</blockquote>`,
  "bantuan": `<blockquote><b>🤖 ${storeName.toUpperCase()} FAQ</b>\n━━━━━━━━━━━━━━━━━━━━\nHalo kak! Ada yang bisa dibantu? Silakan tulis detail kendala atau produk yang ingin dipesan secara lengkap. Admin akan membalas secepatnya.</blockquote>`
};

// ═══════════════════════════════════════
// TELEGRAM CLIENT RUNTIME
// ═══════════════════════════════════════
const stringSession = new StringSession(sessionString);
const client = new TelegramClient(stringSession, apiId, apiHash, {
  connectionRetries: 5,
});

(async () => {
  console.log("⏳ Menghubungkan ke Telegram...");
  
  await client.start({
    phoneNumber: async () => await input.text('Masukkan nomor telepon Telegram Anda (format internasional, misal +628123456789): '),
    password: async () => await input.text('Masukkan password 2FA Anda (jika ada): '),
    phoneCode: async () => await input.text('Masukkan kode verifikasi OTP Telegram Anda: '),
    onError: (err) => console.log('❌ Gagal login:', err),
  });

  console.log("✅ Terkoneksi ke Telegram!");
  const savedSession = client.session.save();

  let myId = "";
  try {
    const me = await client.getMe();
    myId = me.id.toString();
    console.log(`👨‍💻 Akun Userbot Admin ID: ${myId}`);
  } catch (e) {
    console.warn("⚠️ Gagal mendapatkan detail akun Me:", e.message);
  }

  // Deteksi username customer bot dari API Telegram secara dinamis
  await fetchCustomerBotUsername();
  
  if (!sessionString) {
    console.log("\n=======================================================");
    console.log("💡 SALIN DAN SIMPAN STRING SESSION DI BAWAH KE FILE .env:");
    console.log("TELEGRAM_SESSION=" + savedSession);
    console.log("=======================================================\n");
  }

  // ═══════════════════════════════════════
  // MESSAGE HANDLER
  // ═══════════════════════════════════════
  client.addEventHandler(async (event) => {
    console.log(`🔍 DEBUG: Event Diterima: ${event.constructor.name}`);
    const message = event.message;
    if (!message || typeof message.message !== 'string') {
      return;
    }

    console.log(`📩 DEBUG: Pesan Baru: "${message.message}" | Out: ${message.out} | SenderID: ${message.senderId ? message.senderId.toString() : 'null'}`);

    let chatEntity = null;
    try {
      chatEntity = await message.getChat();
      if (!chatEntity) {
        chatEntity = await message.getSender();
      }
    } catch (e) {
      console.log(`🔍 DEBUG: Gagal getChat/getSender: ${e.message}`);
    }

    if (!chatEntity && message.peerId) {
      try {
        chatEntity = await client.getEntity(message.peerId);
      } catch (e) {
        console.log(`🔍 DEBUG: Gagal getEntity dari peerId: ${e.message}`);
      }
    }

    const chatId = message.chatId ? message.chatId.toString() : (chatEntity?.id?.toString() || null);
    console.log(`🔍 DEBUG: ChatID: ${chatId} | AdminID di .env: ${adminId}`);
    if (!chatId) return;
    const senderId = message.senderId ? message.senderId.toString() : null;
    const text = message.message.trim();

    // Entitas target yang valid (mengandung access_hash jika tersedia)
    const targetPeer = chatEntity || message.peerId;

    // Tentukan apakah pengirim pesan adalah admin (pesan keluar / dikirim dari admin)
    const isFromAdmin = message.out || (senderId && (senderId === myId || senderId === adminId));
    console.log(`🔍 DEBUG: isFromAdmin = ${isFromAdmin}`);

    // ───────────────────────────────────────
    // 1. ADMIN COMMANDS HANDLER
    // ───────────────────────────────────────
    if (isFromAdmin && text.startsWith('.')) {
      const parts = text.split(' ');
      const command = parts[0].toLowerCase();
      const args = parts.slice(1);

      // Perintah: .pay <nominal> <deskripsi>
      if (command === '.pay') {
        if (args.length < 2) {
          await client.sendMessage(targetPeer, {
            message: "⚠️ *Format Perintah Salah!*\n\nGunakan: `.pay <nominal> <deskripsi>`\nContoh: `.pay 15000 Netflix Premium`",
            replyTo: message.id
          });
          return;
        }

        const nominal = parseInt(args[0]);
        if (isNaN(nominal) || nominal <= 0) {
          await client.sendMessage(targetPeer, { message: "❌ Nominal harus berupa angka positif!" });
          return;
        }

        const deskripsi = args.slice(1).join(' ');
        const orderId = generateOrderId();

        // Tampilkan status mengetik
        await client.invoke(new Api.messages.SetTyping({
          peer: targetPeer,
          action: new Api.SendMessageTypingAction()
        }));

        let qrBuffer = null;
        let isDynamic = false;

        // Coba bikin QRIS Pakasir jika API Key dikonfigurasi
        if (process.env.PAKASIR_API_KEY && process.env.PAKASIR_PROJECT_NAME) {
          const res = await createPakasirQRIS(orderId, nominal);
          const qrString = res?.payment?.payment_number;
          if (qrString) {
            qrBuffer = await QRCode.toBuffer(qrString);
            qrBuffer.name = "qris.png"; // Set filename for photo detection!
            isDynamic = true;
          }
        }

        // Fallback ke QRIS statis
        if (!qrBuffer) {
          const staticPath = path.resolve(__dirname, process.env.QRIS_IMAGE_PATH || '../whatsapp-bot/assets/qris-dana.jpg');
          if (fs.existsSync(staticPath)) {
            qrBuffer = fs.readFileSync(staticPath);
            qrBuffer.name = "qris.jpg"; // Set filename for photo detection!
          }
        }

        if (!qrBuffer) {
          await client.sendMessage(targetPeer, {
            message: "❌ Gagal membuat invoice. File QRIS statis maupun integrasi Pakasir tidak tersedia."
          });
          return;
        }

        // Simpan ke memory
        activeInvoices.set(chatId, {
          orderId,
          nominal,
          deskripsi,
          createdAt: new Date().toISOString()
        });

        // Buat invoice text
        const invoiceMsg = 
          `<blockquote><b>🧾 ${storeName.toUpperCase()} OFFICIAL INVOICE</b>\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `📅 <b>Tanggal</b> : <code>${getWIBTime()}</code>\n` +
          `🆔 <b>Order ID</b> : <code>${orderId}</code>\n` +
          `🛍️ <b>Detail Item</b> : <i>${escapeHTML(deskripsi)}</i>\n` +
          `💰 <b>Total Pembayaran</b> : <b>${escapeHTML(formatIDR(nominal))}</b>\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `📸 <b>Panduan Pembayaran:</b>\n` +
          `1️⃣ Pindai/Scan QRIS ${isDynamic ? 'Dinamis' : 'Statis'} di bawah ini.\n` +
          `2️⃣ Kirim bukti transfer di chat ini.\n` +
          `3️⃣ Tunggu verifikasi otomatis/admin.\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `💎 <b>Terima kasih telah berbelanja!</b></blockquote>`;

        // Send QRIS and Caption
        await client.sendFile(targetPeer, {
          file: qrBuffer,
          caption: invoiceMsg,
          parseMode: 'html',
          forceDocument: false
        });
        return;
      }

      // Perintah: .done
      if (command === '.done') {
        const activeInvoice = activeInvoices.get(chatId);
        if (!activeInvoice) {
          await client.sendMessage(targetPeer, { message: "❌ Tidak ada invoice aktif untuk chat ini." });
          return;
        }

        const { orderId, nominal, deskripsi, createdAt } = activeInvoice;

        try {
          // Buat data order di Firestore
          await db.collection('orders').doc(orderId).set({
            id: orderId,
            telegramUserId: chatId,
            customerName: chatEntity ? (chatEntity.firstName || chatEntity.title || 'User Telegram') : 'User Telegram',
            telegramUsername: chatEntity ? (chatEntity.username || '') : '',
            productName: deskripsi,
            totalPrice: nominal,
            paymentMethod: 'qris_manual',
            status: 'paid',
            createdAt: createdAt,
            paidAt: new Date().toISOString(),
          });

          // Hapus dari memory
          activeInvoices.delete(chatId);

          await client.sendMessage(targetPeer, {
            message: `<blockquote><b>✅ PEMBAYARAN LUNAS / BERHASIL</b>\n` +
                     `━━━━━━━━━━━━━━━━━━━━\n` +
                     `🆔 <b>Order ID</b> : <code>${orderId}</code>\n` +
                     `🛍️ <b>Detail Item</b> : <i>${escapeHTML(deskripsi)}</i>\n` +
                     `💰 <b>Jumlah Bayar</b> : <b>${escapeHTML(formatIDR(nominal))}</b>\n` +
                     `⏱️ <b>Status Transaksi</b> : <b>LUNAS / PAID</b>\n` +
                     `━━━━━━━━━━━━━━━━━━━━\n` +
                     `🚀 <i>Terima kasih atas pembayaran Anda! Pesanan Anda telah berhasil diproses oleh admin.</i></blockquote>`,
            parseMode: 'html'
          });
        } catch (err) {
          console.error("Gagal simpan order:", err);
          await client.sendMessage(targetPeer, { message: "❌ Terjadi error saat mengupdate status order ke database." });
        }
        return;
      }

      // Perintah: .cancel
      if (command === '.cancel') {
        const activeInvoice = activeInvoices.get(chatId);
        if (!activeInvoice) {
          await client.sendMessage(targetPeer, { message: "❌ Tidak ada invoice aktif untuk chat ini." });
          return;
        }

        activeInvoices.delete(chatId);
        await client.sendMessage(targetPeer, {
          message: `<blockquote><b>❌ TAGIHAN DIBATALKAN</b>\n` +
                   `━━━━━━━━━━━━━━━━━━━━\n` +
                   `🆔 <b>Order ID</b> : <code>${activeInvoice.orderId}</code>\n` +
                   `⚠️ <i>Tagihan aktif di obrolan ini telah dibatalkan oleh admin.</i></blockquote>`,
          parseMode: 'html'
        });
        return;
      }

      // Perintah: .status
      if (command === '.status') {
        const activeInvoice = activeInvoices.get(chatId);
        if (!activeInvoice) {
          await client.sendMessage(targetPeer, { message: "ℹ️ Tidak ada tagihan aktif untuk chat ini." });
          return;
        }

        await client.sendMessage(targetPeer, {
          message: `<blockquote><b>🧾 TAGIHAN AKTIF SAAT INI</b>\n` +
                   `━━━━━━━━━━━━━━━━━━━━\n` +
                   `🆔 <b>Order ID</b> : <code>${activeInvoice.orderId}</code>\n` +
                   `🛍️ <b>Detail Item</b> : <i>${escapeHTML(activeInvoice.deskripsi)}</i>\n` +
                   `💰 <b>Jumlah Tagihan</b> : <b>${escapeHTML(formatIDR(activeInvoice.nominal))}</b>\n` +
                   `📅 <b>Dibuat Pada</b> : <code>${new Date(activeInvoice.createdAt).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}</code>\n` +
                   `━━━━━━━━━━━━━━━━━━━━\n` +
                   `⚠️ <i>Mohon segera selesaikan pembayaran dan kirimkan bukti transfer.</i></blockquote>`,
          parseMode: 'html'
        });
        return;
      }

      // Perintah: .help atau .menu
      if (command === '.help' || command === '.menu') {
        const helpText = 
          `<blockquote><b>🤖 ${storeName.toUpperCase()} USERBOT PANEL</b> 🤖\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `Berikut adalah daftar perintah admin yang tersedia:\n` +
          `\n` +
          `💳 <b>TRANSAKSI</b>\n` +
          `├ <code>.pay &lt;nominal&gt; &lt;deskripsi&gt;</code>\n` +
          `│ ┗ <i>Buat invoice &amp; QRIS baru</i>\n` +
          `├ <code>.done</code>\n` +
          `│ ┗ <i>Konfirmasi pembayaran sukses</i>\n` +
          `├ <code>.cancel</code>\n` +
          `│ ┗ <i>Batalkan invoice aktif</i>\n` +
          `└ <code>.status</code>\n` +
          `  ┗ <i>Cek status invoice saat ini</i>\n` +
          `\n` +
          `ℹ <b>BANTUAN</b>\n` +
          `└ <code>.help</code> / <code>.menu</code>\n` +
          `  ┗ <i>Tampilkan panel menu ini</i>\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `⚠️ <b>Akses khusus Admin ${storeName}</b></blockquote>`;

        await client.sendMessage(targetPeer, {
          message: helpText,
          parseMode: 'html'
        });
        return;
      }
    }

    // ───────────────────────────────────────
    // 2. SPAM CHECKER (ANTI-SPAM) & AUTO-BLOCK
    // ───────────────────────────────────────
    if (!isFromAdmin && senderId) {
      const now = Date.now();
      let times = messageHistory.get(senderId) || [];
      // Hanya simpan pesan dalam 10 detik terakhir
      times = times.filter(t => now - t < 10000);
      times.push(now);
      messageHistory.set(senderId, times);

      if (times.length === 5) {
        // Warning 1
        await client.sendMessage(targetPeer, {
          message: `⚠️ *PERINGATAN SPAM*\nMohon jangan mengirim pesan terlalu cepat. Silakan tunggu antrean agar admin dapat merespons.`
        });
        return;
      }

      if (times.length >= 8) {
        // Blokir user
        try {
          await client.invoke(new Api.contacts.Block({ id: targetPeer }));
          // Kirim log ke Saved Messages admin
          await client.sendMessage('me', {
            message: `🚨 *SPAM BLOCKED LOG*\n\n` +
                     `👤 User: ${chatEntity ? (chatEntity.firstName || '') : ''} ${chatEntity ? (chatEntity.lastName || '') : ''} (@${chatEntity ? (chatEntity.username || 'no_username') : 'no_username'})\n` +
                     `🆔 ID: \`${senderId}\`\n` +
                     `⚠️ Keterangan: Diblokir otomatis karena terdeteksi spamming (>= 8 pesan per 10 detik).`
          });
          console.log(`🔒 User ${senderId} diblokir karena spam.`);
        } catch (e) {
          console.error("Gagal memblokir user:", e.message);
        }
        return;
      }
    }

    // ───────────────────────────────────────
    // 3. AUTO-RESPONDER / FAQ / GEMINI AI
    // ───────────────────────────────────────
    // Hanya merespons jika bukan dari admin dan di private chat (cooldown dinonaktifkan)
    const isPrivateChat = message.peerId && message.peerId.className === 'PeerUser';
    if (!isFromAdmin && senderId && isPrivateChat) {
      const now = Date.now();
      const lastReply = lastAutoReply.get(senderId) || 0;
      const cooldownMs = 0; // Cooldown dinonaktifkan (sebelumnya 5 menit)

      if (now - lastReply > cooldownMs) {
        const lowercaseMsg = text.toLowerCase();

        // Filter lokal untuk mengabaikan pesan yang hanya berupa tawa, emoji, atau teks singkat basa-basi
        const isLaughter = /^(wk|ha|he|xi|wkwk|haha|hehe|xixi|wkwkwk|wkwkkw|wkwkk|hahaha|ha+ha+|wk+wk+)+$/i.test(lowercaseMsg);
        const isEmojiOnly = /^[\p{Emoji}\s]+$/u.test(text) && !/[\w?]/.test(text);
        const isShortAck = /^(ok|oke|siap|sip|y|ya|g|ga|tidak|no|yes|p|ping|thx|thanks|makasih|suwun|wkwk|hehe|haha)$/i.test(lowercaseMsg);

        if (isLaughter || isEmojiOnly || isShortAck) {
          console.log(`🔍 DEBUG: Mengabaikan auto-reply untuk pesan basa-basi/obrolan santai: "${text}"`);
          return;
        }

        let answer = null;

        // A. Cek Keyword FAQ sederhana dahulu
        for (const [kw, resp] of Object.entries(faqKeywords)) {
          if (lowercaseMsg.includes(kw)) {
            answer = resp.replace(/@autoorderbot/g, customerBotUsername);
            break;
          }
        }

        // B. Jika tidak ada keyword yang cocok, dan Gemini AI aktif, gunakan Gemini
        if (!answer && geminiModel) {
          try {
             const productsContext = await getStoreProductsContext();
             const systemPrompt = 
              `Kamu adalah asisten toko digital "${storeName}". Tugasmu adalah menjawab pertanyaan pelanggan secara ramah, singkat (maksimal 2-3 kalimat), padat, dan informatif.\n` +
              `Gunakan data produk, varian, harga, dan stok real-time berikut untuk menjawab pertanyaan jika pelanggan bertanya tentang harga, produk, atau ketersediaan stok:\n\n` +
              `${productsContext}\n\n` +
              `Aturan Penting:\n` +
              `1. Jika pelanggan ingin membeli produk atau menanyakan pricelist lengkap, arahkan dengan sopan untuk menggunakan bot utama kami di Telegram: ${customerBotUsername}.\n` +
              `2. Jika produk/varian yang ditanyakan tidak ada di list atau stok kosong (0), katakan dengan sopan bahwa produk tersebut sedang kosong/tidak tersedia.\n` +
              `3. Jika ada komplain, keluhan transaksi, atau masalah teknis rumit, katakan bahwa admin akan segera membalas chat ini secara manual.\n` +
              `4. Jawablah dengan bahasa Indonesia yang santai, bersahabat, namun tetap sopan. Jangan menggunakan format markdown yang rumit.\n` +
              `5. Jika pesan pelanggan hanya berupa obrolan santai, basa-basi (chitchat), ekspresi tawa, keluhan singkat tanpa pertanyaan (seperti "susah", "gagal"), candaan, atau bukan pertanyaan/pernyataan terkait info produk/pembelian/bantuan toko, kamu WAJIB menjawab hanya dengan satu kata saja: SKIP. Jangan berikan jawaban lainnya.`;

            const prompt = `${systemPrompt}\n\nPesan Pelanggan: "${text}"\nJawaban Asisten:`;
            const result = await geminiModel.generateContent(prompt);
            const responseText = result.response.text();
            
            if (responseText && responseText.trim()) {
              const replyText = responseText.trim();
              if (replyText.toUpperCase() === 'SKIP') {
                console.log(`🔍 DEBUG: Gemini merekomendasikan SKIP untuk pesan: "${text}"`);
                return;
              }
              const cleanResponse = escapeHTML(replyText);
              answer = 
                `<blockquote><b>🤖 ${storeName.toUpperCase()} AUTO-REPLY</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `${cleanResponse}\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `💡 <i>Ketik pesan baru atau hubungi admin jika butuh bantuan manual.</i></blockquote>`;
            }
          } catch (err) {
            console.error("Gagal generate konten dengan Gemini:", err.message);
          }
        }

        // C. Kirim jawaban dengan visual typing effect
        if (answer) {
          // Set status sedang mengetik
          try {
            await client.invoke(new Api.messages.SetTyping({
              peer: targetPeer,
              action: new Api.SendMessageTypingAction()
            }));
          } catch (e) {
            console.warn("⚠️ Gagal menampilkan status mengetik:", e.message);
          }

          // Simulasi delay mengetik natural
          await new Promise(resolve => setTimeout(resolve, 1500));

          await client.sendMessage(targetPeer, {
            message: answer,
            parseMode: 'html'
          });

          // Update timestamp auto-reply untuk menghindari spamming jawaban
          lastAutoReply.set(senderId, now);
        }
      }
    }
  }, new NewMessage({}));

  console.log("🚀 Telegram Admin Userbot berjalan aktif dan mendengarkan event...");
})();
