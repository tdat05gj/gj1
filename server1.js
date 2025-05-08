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
        const firebaseConfig = JSON.parse(Buffer.from(process.env.FIREBASE_CONFIG, 'base64').toString('utf8'));
        res.json(firebaseConfig);
    } catch (error) {
        console.error('Lỗi trả về cấu hình Firebase:', error.message);
        res.status(500).json({ error: 'Không thể lấy cấu hình Firebase' });
    }
});


const encodedFirebaseConfig = process.env.FIREBASE_CONFIG;
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


async function withRetry(fn) {
    try {
        return await fn();
    } catch (error) {
        throw error;
    }
}


async function getBNBPrice() {
    try {
        const response = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=binancecoin&vs_currencies=usdt');
        const price = response.data.binancecoin.usdt;
        if (!price || isNaN(price) || price <= 0) {
            throw new Error('Giá BNB/USDT không hợp lệ');
        }
        console.log(`BNB/USDT: ${price}`);
        return price;
    } catch (error) {
        console.error('Lỗi lấy giá BNB/USDT:', error.message);
        return 597.80;
    }
}


async function isTransactionProcessed(txHash) {
    try {
        const q = query(collection(db, 'purchases'), where('txHash', '==', txHash), where('processed', '==', true));
        const querySnapshot = await getDocs(q);
        return !querySnapshot.empty;
    } catch (error) {
        console.error(`Lỗi kiểm tra txHash ${txHash}:`, error.message);
        return false;
    }
}


async function updateGJBalance(userAddress, ethAmount) {
    try {
        if (!userAddress || !ethers.utils.isAddress(userAddress)) {
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
    }
}


async function processPurchases() {
    try {
        const purchasesRef = collection(db, 'purchases');
        const q = query(purchasesRef, where('processed', '==', false));
        const querySnapshot = await getDocs(q);

        if (querySnapshot.empty) {
            console.log('Không có giao dịch mới');
            return;
        }

        const bnbPriceUsdt = await getBNBPrice();
        const ethPerUsdt = 4;
        const ethPerBnb = bnbPriceUsdt * ethPerUsdt;

        for (const doc of querySnapshot.docs) {
            const data = doc.data();
            const { userAddress, amount, txHash } = data;

            console.log(`Bắt đầu xử lý ${txHash}...`);

            if (await isTransactionProcessed(txHash)) {
                console.log(`Bỏ qua: ${txHash} đã xử lý`);
                continue;
            }

            if (!amount || isNaN(amount) || amount <= 0) {
                console.log(`Lỗi: ${txHash} - Số BNB không hợp lệ`);
                await updateDoc(doc.ref, {
                    processed: true,
                    error: 'Số BNB không hợp lệ',
                    updatedAt: new Date().toISOString()
                });
                continue;
            }

            try {
                const bnbAmount = ethers.parseEther(amount.toString());
                const bscTx = await withRetry(() => contract.recordPurchase(userAddress, bnbAmount));
                await bscTx.wait();

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
                await sepoliaTx.wait();

                await updateGJBalance(userAddress, ethAmount);

                await updateDoc(doc.ref, {
                    processed: true,
                    bscTxHash: bscTx.hash,
                    sepoliaTxHash: sepoliaTx.hash,
                    ethAmount: ethAmount,
                    updatedAt: new Date().toISOString()
                });

                console.log(`Thành công: ${txHash}`);
            } catch (error) {
                console.log(`Lỗi: ${txHash} - ${error.message}`);
                await updateDoc(doc.ref, {
                    processed: true,
                    error: error.message,
                    updatedAt: new Date().toISOString()
                });
            }
        }
    } catch (error) {
        console.error('Lỗi hệ thống:', error.message);
    }
}


setInterval(processPurchases, 1 * 60 * 1000);
processPurchases();


const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));