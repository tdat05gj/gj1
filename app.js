
const contractAddress = "0x07f72a695f5bec4100843dbdca1778d1ddaa94d9";
let contractABI;


fetch("./contract/GJ.json")
    .then(response => {
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        return response.json();
    })
    .then(data => {
        if (!Array.isArray(data)) {
            throw new Error("Invalid ABI format: must be an array");
        }
        contractABI = data;
        init(); 
    })
    .catch(error => {
        console.error("Error loading ABI:", error);
        alert("Failed to load contract ABI. Please check the console for details.");
    });


let provider, signer, contract, userAddress;


async function init() {
    if (typeof window.ethereum === "undefined") {
        alert("Please install MetaMask!");
        return;
    }

    try {
        provider = new ethers.providers.Web3Provider(window.ethereum);
        contract = new ethers.Contract(contractAddress, contractABI, provider);
        document.getElementById("connect-wallet").addEventListener("click", connectWallet);
        document.getElementById("claim-token").addEventListener("click", claimToken);
        document.getElementById("withdraw-token").addEventListener("click", withdrawToken);
    } catch (error) {
        console.error("Error initializing contract:", error);
        alert("Failed to initialize contract. Please check the console for details.");
    }
}


async function connectWallet() {
    try {
        await provider.send("eth_requestAccounts", []);
        signer = provider.getSigner();
        userAddress = await signer.getAddress();
        document.getElementById("wallet-address").innerText = `Wallet: ${userAddress}`;
        document.getElementById("connect-wallet").style.display = "none";
        document.getElementById("claim-token").disabled = false;

       
        const owner = await contract.owner();
        if (userAddress.toLowerCase() === owner.toLowerCase()) {
            document.getElementById("owner-section").style.display = "block";
        }

        
        updateInfo();
    } catch (error) {
        console.error("Error connecting wallet:", error);
        alert("Failed to connect wallet.");
    }
}


async function updateInfo() {
    try {
        // Số dư
        const balance = await contract.balanceOf(userAddress);
        document.getElementById("balance").innerText = `${ethers.utils.formatEther(balance)} GJ`;

      i
        const reward = await contract.calculateReward();
        document.getElementById("current-reward").innerText = `${ethers.utils.formatEther(reward)} GJ`;

       
        const totalClaimed = await contract.getTotalClaimed();
        document.getElementById("total-claimed").innerText = `${ethers.utils.formatEther(totalClaimed)} GJ`;

        
        const lastClaim = await contract.lastClaimTime(userAddress);
        if (lastClaim.toNumber() === 0) {
            document.getElementById("last-claim").innerText = "Never";
        } else {
            const date = new Date(lastClaim.toNumber() * 1000);
            document.getElementById("last-claim").innerText = date.toLocaleString();
        }
    } catch (error) {
        console.error("Error updating info:", error);
    }
}


async function claimToken() {
    try {
        document.getElementById("claim-status").innerText = "Processing...";
        const tx = await contract.connect(signer).claimToken();
        await tx.wait();
        document.getElementById("claim-status").innerText = "Claim successful!";
        updateInfo();
    } catch (error) {
        
    }
}

async function withdrawToken() {
    const amount = document.getElementById("withdraw-amount").value;
    if (!amount || amount <= 0) {
        document.getElementById("withdraw-status").innerText = "Invalid amount";
        return;
    }

    try {
        document.getElementById("withdraw-status").innerText = "Processing...";
        const tx = await contract.connect(signer).withdraw(ethers.utils.parseEther(amount));
        await tx.wait();
        document.getElementById("withdraw-status").innerText = "Withdraw successful!";
        updateInfo();
    } catch (error) {
        console.error("Error withdrawing token:", error);
        document.getElementById("withdraw-status").innerText = "Withdraw failed: " + error.message;
    }
}