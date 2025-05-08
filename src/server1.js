const express = require('express');
const { initializeApp } = require('firebase/app');
const { getFirestore, collection, getDocs, query, where, updateDoc, getDoc, setDoc, doc } = require('firebase/firestore');
const { ethers } = require('ethers');
const axios = require('axios');
require('dotenv').config();

const app = express();

app.use(express.static('public'));

app.get('/firebase-config', (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    try {
        const firebaseConfig = JSON.parse(Buffer.from(process.env.GJ_TEAM, 'base64').toString('utf8'));
        res.json(firebaseConfig);
    } catch (error) {
        console.error('Lỗi:', error.message);
        res.status(500).json({ error: 'Không' });
    }
});

const encodedFirebaseConfig = process.env.GJ_TEAM;
if (!encodedFirebaseConfig) {
    throw new Error('FIREBASE_CONFIG không được cấu hình trong environment variables');
}

const firebaseConfig = JSON.parse(Buffer.from(encodedFirebaseConfig, 'base64').toString('utf8'));

const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);

const bscProvider = new ethers.JsonRpcProvider('https://bsc-dataseed.binance.org/');
const contractAddress = '0x458Ca89eDAd0aDc829694BfA51565bA67AabeF61';
const contractAbi = [
    "function recordPurchase(address buyer, uint256 bnbAmount) external",
    "function withdrawBNB() external",
    "function userBalances(address) view returns (uint256)",
    "function getContractBalance() external view returns (uint256)",
    "event PurchaseRecorded(address indexed buyer, uint256 bnbAmount)",
    "event BNBWithdrawn(address indexed to, uint256 amount)"
];

const sepoliaProvider = new ethers.JsonRpcProvider('https://eth-sepolia.g.alchemy.com/v2/k9hMLc6ueYHBaWa7BYQsXjNd0NGZaubF');

const privateKey = process.env.ENCRYPTION_KEY;
if (!privateKey) {
    throw new Error('ENCRYPTION_KEY không được cấu hình trong environment variables');
}
if (!privateKey.startsWith('0x') || privateKey.length !== 66) {
    throw new Error('ENCRYPTION_KEY không phải private key hợp lệ (cần dạng hex 64 ký tự với 0x)');
}

let bscWallet, sepoliaWallet, contract;
try {
    bscWallet = new ethers.Wallet(privateKey, bscProvider);
    sepoliaWallet = new ethers.Wallet(privateKey, sepoliaProvider);
    contract = new ethers.Contract(contractAddress, contractAbi, bscWallet);
    console.log(`Ví khởi tạo thành công tại: ${new Date().toISOString()}`);
} catch (error) {
    console.error('Lỗi khởi tạo ví:', error.message);
    process.exit(1);
}

async function withRetry(fn, retries = 3, delay = 5000) {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (error) {
            if (i === retries - 1) throw error;
            console.warn(`Thử lại (${i + 1}/${retries}) sau ${delay}ms: ${error.message}`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

async function getBNBPrice() {
    await new Promise(resolve => setTimeout(resolve, 2000));

    const tryBinance = async () => {
        try {
            const response = await axios.get('https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT', {
                headers: { 'User-Agent': 'gjteam-org/1.0 (Node.js)' },
                timeout: 5000 });
            console.log(`Phản hồi Binance (Status: ${response.status}):`, response.data);
            if (!response.data || !response.data.price) {
                throw new Error(`Phản hồi Binance không có trường price: ${JSON.stringify(response.data)}`);
            }
            const price = parseFloat(response.data.price);
            if (!price || isNaN(price) || price <= 0) {
                throw new Error(`Giá BNB/USDT không hợp lệ từ Binance: ${response.data.price}`);
            }
            console.log(`BNB/USDT từ Binance: ${price}`);
            return price;
        } catch (error) {
            if (error.response) {
                throw new Error(`Lỗi HTTP từ Binance: Status ${error.response.status}, Data: ${JSON.stringify(error.response.data)}`);
            }
            throw error;
        }
    };

    const tryCoinMarketCap = async () => {
        const apiKey = process.env.COINMARKETCAP_API_KEY
        if (!apiKey) {
            throw new Error('COINMARKETCAP_API_KEY không được cấu hình trong .env');
        }
        const response = await axios.get('https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest', {
            headers: { 'X-CMC_PRO_API_KEY': apiKey },
            params: { symbol: 'BNB', convert: 'USDT' },
            timeout: 5000 // Timeout 5 giây
        });
        console.log(`Phản hồi CoinMarketCap (Status: ${response.status}):`, response.data);
        const price = response.data.data.BNB?.quote?.USDT?.price;
        if (!price || isNaN(price) || price <= 0) {
            throw new Error(`Giá BNB/USDT không hợp lệ từ CoinMarketCap: ${JSON.stringify(response.data)}`);
        }
        console.log(`BNB/USDT từ CoinMarketCap: ${price}`);
        return price;
    };

    try {
        return await withRetry(tryBinance);
    } catch (error) {
        console.error('Lỗi lấy giá từ Binance:', error.message);
        try {
            return await withRetry(tryCoinMarketCap);
        } catch (cmcError) {
            console.error('Lỗi lấy giá từ CoinMarketCap:', cmcError.message);
            console.warn('Sử dụng giá BNB/USDT mặc định: 597.80');
            return 597.80;
        }
    }
}

async function isTransactionProcessed(txHash) {
    try {
        const q = query(collection(db, 'purchases'), where('txHash', '==', txHash));
        const querySnapshot = await getDocs(q);
        if (querySnapshot.empty) return false;
        const doc = querySnapshot.docs[0];
        const data = doc.data();
        return data.processed === true || data.processing === true;
    } catch (error) {
        console.error(`Lỗi kiểm tra txHash ${txHash}:`, error.message);
        return false;
    }
}

async function updateGJBalance(userAddress, ethAmount) {
    try {
        if (!userAddress || !ethers.isAddress(userAddress)) {
            throw new Error('Địa chỉ ví không hợp lệ');
        }
        if (isNaN(ethAmount) || ethAmount <= 0) {
            throw new Error('Số ETH Sepolia không hợp lệ');
        }

        const gjAmount = ethAmount;
        console.log(`Tính GJ cho ${userAddress}: ${gjAmount} GJ (ETH: ${ethAmount})`);
        const balanceRef = doc(db, 'userBalances', userAddress);
        const balanceDoc = await getDoc(balanceRef);

        let newBalance = gjAmount;
        if (balanceDoc.exists()) {
            const currentBalance = balanceDoc.data().gjBalance || 0;
            newBalance = currentBalance + gjAmount;
            console.log(`Cộng dồn GJ: ${currentBalance} + ${gjAmount} = ${newBalance}`);
        } else {
            console.log(`Tạo mới số dư GJ cho ${userAddress}`);
        }

        await setDoc(balanceRef, {
            gjBalance: newBalance,
            updatedAt: new Date().toISOString()
        }, { merge: true });

        console.log(`GJ cập nhật: ${userAddress} - ${newBalance} GJ`);
    } catch (error) {
        console.error(`Lỗi cập nhật GJ cho ${userAddress}:`, error.message);
        throw error;
    }
}

async function processSinglePurchase(purchaseDoc, bnbPriceUsdt, ethPerUsdt) {
    const startTime = Date.now();
    const data = purchaseDoc.data();
    const { userAddress, amount, txHash } = data;

    console.log(`Kiểm tra ${txHash}...`);

    if (await isTransactionProcessed(txHash)) {
        console.log(`Bỏ qua: ${txHash} đã xử lý hoặc đang xử lý`);
        return;
    }

    await updateDoc(purchaseDoc.ref, {
        processing: true,
        updatedAt: new Date().toISOString()
    });

    console.log(`Bắt đầu xử lý ${txHash}...`);

    if (!amount || isNaN(amount) || amount <= 0) {
        console.error(`Lỗi: ${txHash} - Số BNB không hợp lệ`);
        await updateDoc(purchaseDoc.ref, {
            processed: true,
            processing: false,
            error: 'Số BNB không hợp lệ',
            updatedAt: new Date().toISOString()
        });
        return;
    }

    try {
        const bnbAmount = ethers.parseEther(amount.toString());
        const bscTx = await withRetry(() => contract.recordPurchase(userAddress, bnbAmount));
        const bscReceipt = await bscTx.wait();
        if (bscReceipt.status !== 1) {
            throw new Error('Giao dịch BSC thất bại');
        }
        console.log(`Ghi nhận giao dịch BSC: ${bscTx.hash}`);

        const ethPerBnb = bnbPriceUsdt * ethPerUsdt;
        if (isNaN(ethPerBnb) || ethPerBnb <= 0) {
            throw new Error('Tỷ giá ETH/BNB không hợp lệ');
        }
        const ethToSend = bnbAmount * BigInt(Math.floor(ethPerBnb * 1e18)) / BigInt(1e18);
        const ethAmount = parseFloat(ethers.formatEther(ethToSend));

        const balance = await sepoliaProvider.getBalance(sepoliaWallet.address);
        const feeData = await withRetry(() => sepoliaProvider.getFeeData());
        const gasPrice = feeData.gasPrice;
        const gasLimit = BigInt(21000);
        const txCost = gasPrice * gasLimit + ethToSend;

        if (balance < txCost) {
            throw new Error('Số dư Sepolia không đủ');
        }

        const sepoliaTx = await withRetry(() =>
            sepoliaWallet.sendTransaction({
                to: userAddress,
                value: ethToSend,
                gasLimit: gasLimit,
                gasPrice: gasPrice
            })
        );
        const sepoliaReceipt = await sepoliaTx.wait();
        if (sepoliaReceipt.status !== 1) {
            throw new Error('Giao dịch Sepolia thất bại');
        }
        console.log(`Gửi ETH trên Sepolia: ${sepoliaTx.hash}`);

        await updateGJBalance(userAddress, ethAmount);

        await updateDoc(purchaseDoc.ref, {
            processed: true,
            processing: false,
            bscTxHash: bscTx.hash,
            sepoliaTxHash: sepoliaTx.hash,
            ethAmount: ethAmount,
            updatedAt: new Date().toISOString()
        });

        console.log(`Thành công: ${txHash} (thời gian: ${(Date.now() - startTime) / 1000} giây)`);
    } catch (error) {
        console.error(`Lỗi xử lý ${txHash}: ${error.message}`);
        await updateDoc(purchaseDoc.ref, {
            processed: false,
            processing: false,
            error: error.message,
            updatedAt: new Date().toISOString()
        });
    }
}

let isProcessing = false;

async function processPurchases() {
    if (isProcessing) {
        console.log('Đang xử lý, bỏ qua lần gọi mới');
        return;
    }

    isProcessing = true;
    const startTime = Date.now();
    console.log(`Bắt đầu processPurchases tại: ${new Date().toISOString()}`);

    // Timeout 30 giây
    const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('processPurchases timeout sau 30 giây')), 30000);
    });

    try {
        const result = await Promise.race([
            (async () => {
                const purchasesRef = collection(db, 'purchases');
                const q = query(purchasesRef, where('processed', '==', false));
                const querySnapshot = await getDocs(q);

                if (querySnapshot.empty) {
                    console.log('Không có giao dịch mới');
                    return;
                }

                const bnbPriceUsdt = await getBNBPrice();
                const ethPerUsdt = 4;

            
                const purchasesByUser = {};
                querySnapshot.forEach(doc => {
                    const data = doc.data();
                    if (!purchasesByUser[data.userAddress]) {
                        purchasesByUser[data.userAddress] = [];
                    }
                    purchasesByUser[data.userAddress].push(doc);
                });

               
                const userPromises = Object.values(purchasesByUser).map(async userPurchases => {
                    
                    for (const purchaseDoc of userPurchases) {
                        await processSinglePurchase(purchaseDoc, bnbPriceUsdt, ethPerUsdt);
                    }
                });

                await Promise.all(userPromises);
            })(),
            timeoutPromise
        ]);
        console.log(`processPurchases hoàn thành sau ${(Date.now() - startTime) / 1000} giây`);
        return result;
    } catch (error) {
        console.error('Lỗi hệ thống:', error.message);
        if (error.message.includes('The query requires an index')) {
            console.warn('Yêu cầu index cho collection "purchases".');
            console.warn('Tạo index thủ công tại: https://console.firebase.google.com/project/gjproject1-37e29/firestore/indexes');
            console.warn('Fields: processed (Ascending), txHash (Ascending)');
        }
    } finally {
        isProcessing = false;
        console.log(`Kết thúc processPurchases tại: ${new Date().toISOString()}`);
    }
}

setInterval(processPurchases, 10 * 1000); 
processPurchases();

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));