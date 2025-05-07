const { initializeApp } = require('firebase/app');
const { getFirestore, collection, getDocs, query, where, updateDoc, getDoc, setDoc, doc } = require('firebase/firestore');
const { ethers } = require('ethers');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs').promises;
const fsConstants = require('fs').constants;

// Firebase configuration từ environment variables
const encodedFirebaseConfig = process.env.FIREBASE_CONFIG;
if (!encodedFirebaseConfig) {
    throw new Error('FIREBASE_CONFIG không được cấu hình trong environment variables');
}

// Giải mã Base64 thành object
const firebaseConfig = JSON.parse(Buffer.from(encodedFirebaseConfig, 'base64').toString('utf8'));

// Initialize Firebase
const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);

// BSC Mainnet provider và contract
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

// Sepolia provider
const sepoliaProvider = new ethers.JsonRpcProvider('https://eth-sepolia.g.alchemy.com/v2/k9hMLc6ueYHBaWa7BYQsXjNd0NGZaubF');

// Hàm giải mã private key từ file
async function decryptKey(filePath, encryptionKey) {
    try {
        await fs.access(filePath, fsConstants.R_OK);
        const content = await fs.readFile(filePath, 'utf8');
        const [iv, encryptedKey, authTag] = content.split(':');
        const keyBuffer = Buffer.from(encryptionKey, 'hex');
        const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuffer, Buffer.from(iv, 'hex'));
        decipher.setAuthTag(Buffer.from(authTag, 'hex'));
        let decrypted = decipher.update(Buffer.from(encryptedKey, 'hex'), null, 'utf8');
        decrypted += decipher.final('utf8');
        console.log(`Private key giải mã tại: ${new Date().toISOString()}`);
        return decrypted;
    } catch (error) {
        throw new Error('Giải mã private key thất bại: ' + error.message);
    }
}

// Khởi tạo ví owner
const encryptionKey = process.env.ENCRYPTION_KEY;
if (!encryptionKey) {
    throw new Error('ENCRYPTION_KEY không được cấu hình trong environment variables');
}

let bscWallet, sepoliaWallet, contract;
(async () => {
    try {
        const privateKey = await decryptKey('./secure/key.enc', encryptionKey);
        bscWallet = new ethers.Wallet(privateKey, bscProvider);
        sepoliaWallet = new ethers.Wallet(privateKey, sepoliaProvider);
        contract = new ethers.Contract(contractAddress, contractAbi, bscWallet);
    } catch (error) {
        console.error('Lỗi khởi tạo ví:', error.message);
        process.exit(1);
    }
})();

// Hàm retry với timeout (chỉ thử 1 lần)
async function withRetry(fn) {
    try {
        return await fn();
    } catch (error) {
        throw error;
    }
}

// Lấy giá BNB/USDT từ CoinGecko API
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

// Kiểm tra trùng lặp giao dịch
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

// Cập nhật số dư GJ
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

// Hàm xử lý giao dịch
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

// Chạy xử lý giao dịch mỗi 1 phút
setInterval(processPurchases, 1 * 60 * 1000);
processPurchases();

console.log('Server1 running');