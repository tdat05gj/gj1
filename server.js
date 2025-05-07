const express = require('express');
const compression = require('compression');
const path = require('path');
const { ethers } = require('ethers');
const fs = require('fs').promises;
const fsConstants = require('fs').constants;

const app = express();
app.use(compression());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Middleware để đảm bảo luôn trả về JSON
app.use((req, res, next) => {
    res.setHeader('Content-Type', 'application/json');
    next();
});

// Route chính trả về giao diện starry
app.get('/', async (req, res) => {
    try {
        await fs.access(path.join(__dirname, 'public', 'index.html'), fsConstants.R_OK);
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    } catch (error) {
        res.status(500).json({ success: false, error: 'Không tìm thấy giao diện' });
    }
});

const createWallet = () => {
    const wallet = ethers.Wallet.createRandom();
    return {
        address: wallet.address,
        privateKey: wallet.privateKey,
        mnemonic: wallet.mnemonic.phrase
    };
};

// Tạo một ví với đuôi tùy chỉnh
app.post('/generate', async (req, res) => {
    try {
        const desiredEnding = req.body.ending;

        if (!desiredEnding || typeof desiredEnding !== 'string') {
            return res.status(400).json({ success: false, error: 'Invalid ending specified' });
        }

        let found = false;
        let walletInfo;

        while (!found) {
            if (req.aborted) {
                return res.status(499).json({ success: false, error: 'Request cancelled by client' });
            }
            const wallet = createWallet();
            if (wallet.address.endsWith(desiredEnding)) {
                found = true;
                walletInfo = wallet;
            }
        }

        res.json({ success: true, ...walletInfo });
    } catch (error) {
        console.error('Error in /generate:', error);
        res.status(500).json({ success: false, error: error.message || 'Server error' });
    }
});

// Tạo nhiều ví ngẫu nhiên
app.post('/generate-multiple', async (req, res) => {
    try {
        const numWallets = req.body.numWallets;
        if (!numWallets || typeof numWallets !== 'number' || numWallets < 1) {
            return res.status(400).json({ success: false, error: 'Invalid number of wallets specified' });
        }
        if (numWallets > 100) {
            return res.status(400).json({ success: false, error: 'Maximum 100 wallets allowed' });
        }

        const wallets = [];
        for (let i = 0; i < numWallets; i++) {
            if (req.aborted) {
                return res.status(499).json({ success: false, error: 'Request cancelled by client' });
            }
            const wallet = createWallet();
            wallets.push(wallet);
        }

        res.json({ success: true, wallets: wallets });
    } catch (error) {
        console.error('Error in /generate-multiple:', error);
        res.status(500).json({ success: false, error: error.message || 'Server error' });
    }
});

// Xử lý lỗi không tìm thấy route
app.use((req, res) => {
    res.status(404).json({ success: false, error: 'Route not found' });
});

// Mở cổng từ PORT environment variable (Render yêu cầu port 10000)
const port = process.env.PORT || 10000;
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});