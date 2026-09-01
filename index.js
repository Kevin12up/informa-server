const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers
} = require('@whiskeysockets/baileys');
const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());

const sessions = {}; // Menyimpan instance koneksi WhatsApp yang aktif

// 1. Endpoint API: Membuat Sesi Baru & Mengembalikan QR Code
app.post('/session/start', async (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: "sessionId diperlukan" });

    // Jika sesi sudah ada dan aktif terhubung
    if (sessions[sessionId] && sessions[sessionId].isReady) {
        return res.json({ status: "connected", message: "Sesi sudah terhubung" });
    }

    const sessionDir = path.join(__dirname, `sessions/${sessionId}`);
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    
    // Ambil versi Web WhatsApp terbaru agar QR valid dan tidak ditolak
    let version = [2, 3000, 1015901307];
    try {
        const latest = await fetchLatestBaileysVersion();
        version = latest.version;
    } catch (e) {}

    const arc = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        auth: state,
        // Wajib: Identitas Browser Resmi agar WhatsApp menerima QR Code
        browser: Browsers.ubuntu('Chrome'),
        printQRInTerminal: false,
        syncFullHistory: false
    });

    sessions[sessionId] = arc;

    arc.ev.on('creds.update', saveCreds);
    arc.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            // Mengubah QR menjadi Gambar Base64 murni
            const qrImageBase64 = await QRCode.toDataURL(qr, { margin: 2, scale: 8 });
            sessions[sessionId].latestQr = qrImageBase64;
            sessions[sessionId].isReady = false;
        }

        if (connection === 'open') {
            sessions[sessionId].isReady = true;
            sessions[sessionId].latestQr = null;
            console.log(`[INFO] Sesi ${sessionId} Berhasil Terhubung ke WhatsApp!`);
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (!shouldReconnect) {
                delete sessions[sessionId];
                try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {}
            }
        }
    });

    // Beri waktu Baileys merender QR awal lalu kirim ke client
    setTimeout(() => {
        if (sessions[sessionId]?.isReady) {
            res.json({ status: "connected" });
        } else if (sessions[sessionId]?.latestQr) {
            res.json({ status: "qr", qr: sessions[sessionId].latestQr });
        } else {
            res.json({ status: "pending", message: "Sedang memproses QR, silakan tekan refresh" });
        }
    }, 2500);
});

// 2. Endpoint API: Mengirim Pesan Teks Standar
app.post('/session/send-message', async (req, res) => {
    const { sessionId, target, message } = req.body;
    const client = sessions[sessionId];

    if (!client || !client.isReady) {
        return res.status(400).json({ error: "Sesi WhatsApp belum terhubung atau belum di-scan" });
    }
    if (!target) return res.status(400).json({ error: "Target nomor diperlukan" });

    const targetJid = target.includes('@s.whatsapp.net') ? target : `${target}@s.whatsapp.net`;
    const textToSend = message || "Pesan dari sistem Informa Client.";

    try {
        await client.sendMessage(targetJid, { text: textToSend });
        res.json({ status: "success", message: "Pesan berhasil dikirim" });
    } catch (err) {
        console.error("Gagal mengirim pesan:", err);
        res.status(500).json({ error: "Gagal mengirim pesan", details: err.message });
    }
});

// Jalankan server pada Port Otomatis Lingkungan Hosting (Railway / Render / VPS)
const PORT = process.env.PORT || process.env.SERVER_PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server Multi-Session berjalan di port ${PORT}`);
});
