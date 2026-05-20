//! Base mainnet chain client (alloy). Handles:
//!  - reading ERC20 balances for the inventory snapshot
//!  - verifying user deposit transactions
//!  - sending ERC20 transfers to deliver output / refund input

use crate::config::Config;
use crate::error::AppError;
use alloy::network::EthereumWallet;
use alloy::primitives::{Address, B256, U256};
use alloy::providers::{Provider, ProviderBuilder};
use alloy::rpc::types::TransactionReceipt;
use alloy::signers::local::PrivateKeySigner;
use alloy::sol;
use anyhow::Result;
use std::str::FromStr;
use tracing::{debug, info};

// Minimal ERC20 ABI: balanceOf + transfer + Transfer event.
sol! {
    #[sol(rpc)]
    contract IERC20 {
        function balanceOf(address account) external view returns (uint256);
        function transfer(address to, uint256 amount) external returns (bool);
        event Transfer(address indexed from, address indexed to, uint256 value);
    }
}

pub struct ChainClient {
    pub provider: alloy::providers::fillers::FillProvider<
        alloy::providers::fillers::JoinFill<
            alloy::providers::Identity,
            alloy::providers::fillers::JoinFill<
                alloy::providers::fillers::GasFiller,
                alloy::providers::fillers::JoinFill<
                    alloy::providers::fillers::BlobGasFiller,
                    alloy::providers::fillers::JoinFill<
                        alloy::providers::fillers::NonceFiller,
                        alloy::providers::fillers::ChainIdFiller,
                    >,
                >,
            >,
        >,
        alloy::providers::RootProvider<alloy::transports::http::Http<reqwest::Client>>,
        alloy::transports::http::Http<reqwest::Client>,
        alloy::network::Ethereum,
    >,
    // Separate provider with signer wallet, used for state-changing calls.
    pub wallet_provider: WalletProvider,
    signer: PrivateKeySigner,
    usdc: Address,
    cbbtc: Address,
}

pub type WalletProvider = alloy::providers::fillers::FillProvider<
    alloy::providers::fillers::JoinFill<
        alloy::providers::fillers::JoinFill<
            alloy::providers::Identity,
            alloy::providers::fillers::JoinFill<
                alloy::providers::fillers::GasFiller,
                alloy::providers::fillers::JoinFill<
                    alloy::providers::fillers::BlobGasFiller,
                    alloy::providers::fillers::JoinFill<
                        alloy::providers::fillers::NonceFiller,
                        alloy::providers::fillers::ChainIdFiller,
                    >,
                >,
            >,
        >,
        alloy::providers::fillers::WalletFiller<EthereumWallet>,
    >,
    alloy::providers::RootProvider<alloy::transports::http::Http<reqwest::Client>>,
    alloy::transports::http::Http<reqwest::Client>,
    alloy::network::Ethereum,
>;

impl ChainClient {
    pub async fn new(config: &Config) -> Result<Self> {
        let signer = PrivateKeySigner::from_str(&config.solver_private_key)?;
        let rpc_url = config
            .base_rpc_url
            .parse()
            .map_err(|e| anyhow::anyhow!("invalid BASE_RPC_URL: {}", e))?;

        let provider = ProviderBuilder::new()
            .with_recommended_fillers()
            .on_http(rpc_url);

        let wallet = EthereumWallet::from(signer.clone());
        let rpc_url2 = config
            .base_rpc_url
            .parse()
            .map_err(|e| anyhow::anyhow!("invalid BASE_RPC_URL: {}", e))?;
        let wallet_provider = ProviderBuilder::new()
            .with_recommended_fillers()
            .wallet(wallet)
            .on_http(rpc_url2);

        Ok(Self {
            provider,
            wallet_provider,
            signer,
            usdc: config.usdc_address,
            cbbtc: config.cbbtc_address,
        })
    }

    pub fn solver_address(&self) -> Address {
        self.signer.address()
    }

    /// Read ERC20 balance.
    pub async fn balance_of(&self, token: Address, account: Address) -> Result<U256, AppError> {
        let erc20 = IERC20::new(token, &self.provider);
        let bal = erc20
            .balanceOf(account)
            .call()
            .await
            .map_err(|e| AppError::Chain(format!("balanceOf failed: {}", e)))?;
        Ok(bal._0)
    }

    pub async fn inventory_snapshot(&self) -> InventorySnapshot {
        let solver = self.solver_address();
        let usdc = self.balance_of(self.usdc, solver).await.ok();
        let cbbtc = self.balance_of(self.cbbtc, solver).await.ok();
        InventorySnapshot {
            solver,
            usdc_eoa: usdc.map(|b| b.to_string()),
            cbbtc_eoa: cbbtc.map(|b| b.to_string()),
        }
    }

    /// Verify a user's deposit transaction. Returns Ok(amount) if the tx is
    /// a confirmed ERC20.transfer matching (token, from=user, to=solver, amount≥expected).
    ///
    /// The "≥" is intentional: KalqiX-deployed tokens on testnet had standard
    /// transfer semantics so amount-received == amount-sent, but if we ever
    /// support fee-on-transfer tokens we'd accept any value ≥ expected.
    pub async fn verify_deposit(
        &self,
        tx_hash: B256,
        expected_token: Address,
        expected_from: Address,
        expected_amount: U256,
    ) -> Result<U256, AppError> {
        let receipt: Option<TransactionReceipt> = self
            .provider
            .get_transaction_receipt(tx_hash)
            .await
            .map_err(|e| AppError::Chain(format!("get_transaction_receipt: {}", e)))?;
        let receipt = receipt
            .ok_or_else(|| AppError::Validation(format!("tx {} not yet mined", tx_hash)))?;

        if !receipt.status() {
            return Err(AppError::Validation(format!(
                "tx {} reverted onchain",
                tx_hash
            )));
        }

        // Walk the logs for an ERC20 Transfer matching our expected signature.
        let solver = self.solver_address();
        let mut found: Option<U256> = None;
        for log in receipt.inner.logs() {
            // Decode topics
            let topics = log.topics();
            if topics.len() < 3 {
                continue;
            }
            // Topic 0 = event sig hash
            let transfer_sig = alloy::primitives::keccak256(b"Transfer(address,address,uint256)");
            if topics[0] != transfer_sig {
                continue;
            }
            // Token contract emitting the event
            if log.address() != expected_token {
                continue;
            }
            // Topic 1 = from (indexed), padded to 32 bytes
            let from = Address::from_slice(&topics[1].as_slice()[12..]);
            let to = Address::from_slice(&topics[2].as_slice()[12..]);
            if from != expected_from || to != solver {
                continue;
            }
            // Data = value (uint256)
            let data = log.data().data.clone();
            if data.len() != 32 {
                continue;
            }
            let value = U256::from_be_slice(&data);
            if value >= expected_amount {
                found = Some(value);
                break;
            }
        }

        match found {
            Some(v) => {
                debug!(?tx_hash, value = %v, "deposit verified");
                Ok(v)
            }
            None => Err(AppError::Validation(format!(
                "tx {} contains no matching Transfer({}, {}, ≥{})",
                tx_hash, expected_from, solver, expected_amount
            ))),
        }
    }

    /// Transfer ERC20 from the solver EOA to a recipient. Returns the tx hash.
    pub async fn transfer_erc20(
        &self,
        token: Address,
        to: Address,
        amount: U256,
    ) -> Result<B256, AppError> {
        info!(token = %token, to = %to, amount = %amount, "broadcasting ERC20 transfer");
        let erc20 = IERC20::new(token, &self.wallet_provider);
        let pending = erc20
            .transfer(to, amount)
            .send()
            .await
            .map_err(|e| AppError::Chain(format!("transfer send failed: {}", e)))?;
        let hash = *pending.tx_hash();
        info!(%hash, "transfer broadcast");
        // Wait for confirmation (1 block). Receipt timeout safety: ~30s.
        let _receipt = tokio::time::timeout(
            std::time::Duration::from_secs(30),
            pending.get_receipt(),
        )
        .await
        .map_err(|_| AppError::Chain("transfer receipt timeout".into()))?
        .map_err(|e| AppError::Chain(format!("transfer receipt error: {}", e)))?;
        Ok(hash)
    }
}

#[derive(Debug, serde::Serialize)]
pub struct InventorySnapshot {
    pub solver: Address,
    pub usdc_eoa: Option<String>,
    pub cbbtc_eoa: Option<String>,
    // KalqiX-side balances are not added here — would require a separate
    // KalqiX /portfolios/me query. Operator can confirm via dashboard for MVP.
}
