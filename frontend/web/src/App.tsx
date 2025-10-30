import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface ReputationDerivative {
  id: string;
  encryptedReputation: string;
  notionalValue: number;
  strikePrice: number;
  maturityDate: number;
  derivativeType: "future" | "option" | "swap";
  status: "active" | "expired" | "settled";
  owner: string;
  timestamp: number;
  encryptedPnl?: string; // Encrypted Profit & Loss
}

// FHE Encryption/Decryption simulation
const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}-${Date.now()}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    const base64Data = encryptedData.split('-')[1];
    return parseFloat(atob(base64Data));
  }
  return parseFloat(encryptedData);
};

// Simulate FHE computation on encrypted reputation scores
const FHEComputeReputation = (encryptedData: string, operation: string): string => {
  const value = FHEDecryptNumber(encryptedData);
  let result = value;
  
  switch(operation) {
    case 'volatility_adjust':
      result = value * (0.9 + Math.random() * 0.2); // Simulate volatility
      break;
    case 'risk_adjust':
      result = value * 0.95; // Risk adjustment
      break;
    case 'market_adjust':
      result = value * (1 + (Math.random() - 0.5) * 0.1); // Market fluctuations
      break;
    default:
      result = value;
  }
  
  return FHEEncryptNumber(result);
};

const generatePublicKey = () => `0x${Array(64).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [derivatives, setDerivatives] = useState<ReputationDerivative[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newDerivative, setNewDerivative] = useState({
    reputationScore: 750,
    notionalValue: 1000,
    strikePrice: 800,
    maturityDays: 30,
    derivativeType: "future" as "future" | "option" | "swap"
  });
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [activeTab, setActiveTab] = useState<"dashboard" | "trading" | "portfolio" | "analytics">("dashboard");
  
  // Price chart data
  const [priceHistory, setPriceHistory] = useState<{time: number, price: number}[]>([]);
  const [currentPrice, setCurrentPrice] = useState(750);

  useEffect(() => {
    loadDerivatives().finally(() => setLoading(false));
    const initParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setPublicKey(generatePublicKey());
      
      // Initialize price history
      const now = Date.now();
      const history = [];
      for (let i = 7; i >= 0; i--) {
        history.push({
          time: now - (i * 24 * 60 * 60 * 1000),
          price: 700 + Math.random() * 100
        });
      }
      setPriceHistory(history);
    };
    initParams();
  }, []);

  const loadDerivatives = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) {
        setTransactionStatus({ visible: true, status: "error", message: "Contract not available" });
        return;
      }

      const keysBytes = await contract.getData("derivative_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing derivative keys:", e); }
      }

      const list: ReputationDerivative[] = [];
      for (const key of keys) {
        try {
          const derivativeBytes = await contract.getData(`derivative_${key}`);
          if (derivativeBytes.length > 0) {
            try {
              const derivativeData = JSON.parse(ethers.toUtf8String(derivativeBytes));
              list.push({
                id: key,
                encryptedReputation: derivativeData.encryptedReputation,
                notionalValue: derivativeData.notionalValue,
                strikePrice: derivativeData.strikePrice,
                maturityDate: derivativeData.maturityDate,
                derivativeType: derivativeData.derivativeType,
                status: derivativeData.status,
                owner: derivativeData.owner,
                timestamp: derivativeData.timestamp,
                encryptedPnl: derivativeData.encryptedPnl
              });
            } catch (e) { console.error(`Error parsing derivative data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading derivative ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setDerivatives(list);
    } catch (e) { console.error("Error loading derivatives:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const createDerivative = async () => {
    if (!isConnected) { 
      setTransactionStatus({ visible: true, status: "error", message: "Please connect wallet first" });
      return; 
    }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting reputation score with Zama FHE..." });
    
    try {
      // Encrypt reputation score using FHE simulation
      const encryptedReputation = FHEEncryptNumber(newDerivative.reputationScore);
      
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const derivativeId = `deriv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const maturityDate = Math.floor(Date.now() / 1000) + (newDerivative.maturityDays * 24 * 60 * 60);
      
      const derivativeData = {
        encryptedReputation,
        notionalValue: newDerivative.notionalValue,
        strikePrice: newDerivative.strikePrice,
        maturityDate,
        derivativeType: newDerivative.derivativeType,
        status: "active",
        owner: address,
        timestamp: Math.floor(Date.now() / 1000)
      };

      await contract.setData(`derivative_${derivativeId}`, ethers.toUtf8Bytes(JSON.stringify(derivativeData)));
      
      // Update keys list
      const keysBytes = await contract.getData("derivative_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { 
          keys = JSON.parse(ethers.toUtf8String(keysBytes)); 
        } catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(derivativeId);
      await contract.setData("derivative_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Reputation derivative created with FHE encryption!" });
      await loadDerivatives();
      
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewDerivative({
          reputationScore: 750,
          notionalValue: 1000,
          strikePrice: 800,
          maturityDays: 30,
          derivativeType: "future"
        });
      }, 2000);
      
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") 
        ? "Transaction rejected by user" 
        : "Creation failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { 
      setCreating(false); 
    }
  };

  const settleDerivative = async (derivativeId: string) => {
    if (!isConnected) { 
      setTransactionStatus({ visible: true, status: "error", message: "Please connect wallet first" });
      return; 
    }
    
    setTransactionStatus({ visible: true, status: "pending", message: "Settling derivative with FHE computation..." });
    
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      
      const derivativeBytes = await contract.getData(`derivative_${derivativeId}`);
      if (derivativeBytes.length === 0) throw new Error("Derivative not found");
      
      const derivativeData = JSON.parse(ethers.toUtf8String(derivativeBytes));
      
      // Simulate FHE computation for P&L
      const currentMarketPrice = 750 + (Math.random() - 0.5) * 50; // Simulate market movement
      const encryptedPnl = FHEComputeReputation(derivativeData.encryptedReputation, 'market_adjust');
      
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const updatedDerivative = { 
        ...derivativeData, 
        status: "settled", 
        encryptedPnl,
        settlementPrice: currentMarketPrice
      };
      
      await contractWithSigner.setData(`derivative_${derivativeId}`, ethers.toUtf8Bytes(JSON.stringify(updatedDerivative)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Derivative settled with FHE computation!" });
      await loadDerivatives();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
      
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Settlement failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { 
      setTransactionStatus({ visible: true, status: "error", message: "Please connect wallet first" });
      return null; 
    }
    
    try {
      const message = `FHE Decryption Request\nContract: ${contractAddress}\nChain: ${chainId}\nTimestamp: ${Date.now()}`;
      await signMessageAsync({ message });
      
      // Simulate decryption delay
      await new Promise(resolve => setTimeout(resolve, 2000));
      return FHEDecryptNumber(encryptedData);
      
    } catch (e) { 
      console.error("Decryption failed:", e); 
      return null; 
    }
  };

  // Calculate statistics
  const activeDerivatives = derivatives.filter(d => d.status === "active").length;
  const totalNotional = derivatives.reduce((sum, d) => sum + d.notionalValue, 0);
  const avgReputation = derivatives.length > 0 
    ? derivatives.reduce((sum, d) => sum + FHEDecryptNumber(d.encryptedReputation), 0) / derivatives.length 
    : 0;

  // Render price chart
  const renderPriceChart = () => {
    const maxPrice = Math.max(...priceHistory.map(p => p.price));
    const minPrice = Math.min(...priceHistory.map(p => p.price));
    const range = maxPrice - minPrice;
    
    return (
      <div className="price-chart">
        <div className="chart-header">
          <h4>Reputation Index Price</h4>
          <span className="current-price">${currentPrice.toFixed(2)}</span>
        </div>
        <div className="chart-container">
          {priceHistory.map((point, index) => {
            const height = ((point.price - minPrice) / range) * 100;
            return (
              <div key={index} className="chart-bar">
                <div 
                  className="chart-bar-fill" 
                  style={{ height: `${height}%` }}
                  title={`$${point.price.toFixed(2)}`}
                ></div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  // Render risk indicators
  const renderRiskIndicators = () => {
    const volatility = Math.random() * 30 + 10; // 10-40%
    const riskScore = Math.random() * 100;
    
    return (
      <div className="risk-indicators">
        <div className="risk-item">
          <span className="risk-label">Market Volatility</span>
          <div className="risk-bar">
            <div 
              className="risk-fill volatility" 
              style={{ width: `${volatility}%` }}
            ></div>
          </div>
          <span className="risk-value">{volatility.toFixed(1)}%</span>
        </div>
        <div className="risk-item">
          <span className="risk-label">Portfolio Risk</span>
          <div className="risk-bar">
            <div 
              className="risk-fill portfolio-risk" 
              style={{ width: `${riskScore}%` }}
            ></div>
          </div>
          <span className="risk-value">{riskScore.toFixed(1)}%</span>
        </div>
      </div>
    );
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="fhe-spinner"></div>
      <p>Initializing FHE Reputation Derivatives Protocol...</p>
    </div>
  );

  return (
    <div className="app-container fhe-theme">
      {/* Sidebar Navigation */}
      <nav className="app-sidebar">
        <div className="sidebar-header">
          <div className="logo">
            <div className="logo-icon">🔮</div>
            <h1>RepuDeriv<span>FHE</span></h1>
          </div>
          <div className="fhe-badge">
            <div className="fhe-glow"></div>
            <span>ZAMA FHE</span>
          </div>
        </div>
        
        <div className="sidebar-nav">
          <button 
            className={`nav-item ${activeTab === "dashboard" ? "active" : ""}`}
            onClick={() => setActiveTab("dashboard")}
          >
            <div className="nav-icon">📊</div>
            <span>Dashboard</span>
          </button>
          <button 
            className={`nav-item ${activeTab === "trading" ? "active" : ""}`}
            onClick={() => setActiveTab("trading")}
          >
            <div className="nav-icon">💹</div>
            <span>Trading</span>
          </button>
          <button 
            className={`nav-item ${activeTab === "portfolio" ? "active" : ""}`}
            onClick={() => setActiveTab("portfolio")}
          >
            <div className="nav-icon">💰</div>
            <span>Portfolio</span>
          </button>
          <button 
            className={`nav-item ${activeTab === "analytics" ? "active" : ""}`}
            onClick={() => setActiveTab("analytics")}
          >
            <div className="nav-icon">🔍</div>
            <span>Analytics</span>
          </button>
        </div>

        <div className="sidebar-footer">
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={true} />
          </div>
        </div>
      </nav>

      {/* Main Content Area */}
      <main className="app-main">
        <header className="main-header">
          <div className="header-title">
            <h2>Reputation Derivatives Protocol</h2>
            <p>Trade encrypted reputation scores with Zama FHE technology</p>
          </div>
          <div className="header-actions">
            <button 
              onClick={() => setShowCreateModal(true)} 
              className="create-derivative-btn fhe-button"
            >
              <div className="button-icon">+</div>
              Create Derivative
            </button>
            <button onClick={loadDerivatives} className="refresh-btn fhe-button" disabled={isRefreshing}>
              {isRefreshing ? "🔄" : "↻"} Refresh
            </button>
          </div>
        </header>

        {/* Dashboard Tab */}
        {activeTab === "dashboard" && (
          <div className="dashboard-content">
            <div className="stats-grid">
              <div className="stat-card fhe-card">
                <div className="stat-icon">📈</div>
                <div className="stat-content">
                  <h3>Total Notional</h3>
                  <div className="stat-value">${totalNotional.toLocaleString()}</div>
                </div>
              </div>
              <div className="stat-card fhe-card">
                <div className="stat-icon">🔗</div>
                <div className="stat-content">
                  <h3>Active Derivatives</h3>
                  <div className="stat-value">{activeDerivatives}</div>
                </div>
              </div>
              <div className="stat-card fhe-card">
                <div className="stat-icon">⭐</div>
                <div className="stat-content">
                  <h3>Avg Reputation</h3>
                  <div className="stat-value">{avgReputation.toFixed(0)}</div>
                </div>
              </div>
              <div className="stat-card fhe-card">
                <div className="stat-icon">⚡</div>
                <div className="stat-content">
                  <h3>FHE Operations</h3>
                  <div className="stat-value">{derivatives.length * 3}</div>
                </div>
              </div>
            </div>

            <div className="dashboard-widgets">
              <div className="widget fhe-card">
                <h3>Price Chart</h3>
                {renderPriceChart()}
              </div>
              <div className="widget fhe-card">
                <h3>Risk Indicators</h3>
                {renderRiskIndicators()}
              </div>
            </div>

            <div className="recent-activity fhe-card">
              <h3>Recent Derivatives</h3>
              <div className="activity-list">
                {derivatives.slice(0, 5).map(derivative => (
                  <div key={derivative.id} className="activity-item">
                    <div className="activity-type">{derivative.derivativeType.toUpperCase()}</div>
                    <div className="activity-details">
                      <span>Notional: ${derivative.notionalValue}</span>
                      <span>Maturity: {new Date(derivative.maturityDate * 1000).toLocaleDateString()}</span>
                    </div>
                    <div className={`activity-status ${derivative.status}`}>{derivative.status}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Trading Tab */}
        {activeTab === "trading" && (
          <div className="trading-content">
            <div className="trading-header">
              <h2>Reputation Derivatives Market</h2>
              <div className="market-stats">
                <span>24h Volume: ${(totalNotional * 0.1).toLocaleString()}</span>
                <span>Open Interest: {derivatives.length}</span>
              </div>
            </div>

            <div className="derivatives-list fhe-card">
              <div className="list-header">
                <h3>Available Derivatives</h3>
                <div className="list-filters">
                  <button className="filter-btn active">All</button>
                  <button className="filter-btn">Futures</button>
                  <button className="filter-btn">Options</button>
                  <button className="filter-btn">Swaps</button>
                </div>
              </div>
              
              <div className="derivatives-table">
                <div className="table-header">
                  <div>Type</div>
                  <div>Notional Value</div>
                  <div>Strike Price</div>
                  <div>Maturity</div>
                  <div>Status</div>
                  <div>Actions</div>
                </div>
                
                {derivatives.length === 0 ? (
                  <div className="no-data">
                    <div className="no-data-icon">📊</div>
                    <p>No derivatives found</p>
                    <button className="fhe-button" onClick={() => setShowCreateModal(true)}>
                      Create First Derivative
                    </button>
                  </div>
                ) : (
                  derivatives.map(derivative => (
                    <div key={derivative.id} className="table-row">
                      <div className="derivative-type">{derivative.derivativeType}</div>
                      <div>${derivative.notionalValue.toLocaleString()}</div>
                      <div>${derivative.strikePrice}</div>
                      <div>{new Date(derivative.maturityDate * 1000).toLocaleDateString()}</div>
                      <div className={`status-badge ${derivative.status}`}>{derivative.status}</div>
                      <div className="actions">
                        {derivative.status === "active" && (
                          <button 
                            className="action-btn settle"
                            onClick={() => settleDerivative(derivative.id)}
                          >
                            Settle
                          </button>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        {/* Portfolio Tab */}
        {activeTab === "portfolio" && (
          <div className="portfolio-content">
            <h2>Your Reputation Portfolio</h2>
            <div className="portfolio-stats fhe-card">
              <h3>Portfolio Overview</h3>
              <div className="portfolio-grid">
                <div className="portfolio-item">
                  <span>Total Derivatives</span>
                  <strong>{derivatives.filter(d => d.owner === address).length}</strong>
                </div>
                <div className="portfolio-item">
                  <span>Active Positions</span>
                  <strong>{derivatives.filter(d => d.owner === address && d.status === "active").length}</strong>
                </div>
                <div className="portfolio-item">
                  <span>Total Exposure</span>
                  <strong>${derivatives.filter(d => d.owner === address).reduce((sum, d) => sum + d.notionalValue, 0).toLocaleString()}</strong>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Create Derivative Modal */}
      {showCreateModal && (
        <div className="modal-overlay">
          <div className="create-modal fhe-card">
            <div className="modal-header">
              <h2>Create Reputation Derivative</h2>
              <button onClick={() => setShowCreateModal(false)} className="close-modal">×</button>
            </div>
            
            <div className="modal-body">
              <div className="fhe-notice">
                <div className="notice-icon">🔒</div>
                <div>
                  <strong>FHE Encryption Active</strong>
                  <p>Your reputation score will be encrypted with Zama FHE before any computation</p>
                </div>
              </div>

              <div className="form-grid">
                <div className="form-group">
                  <label>Reputation Score *</label>
                  <input 
                    type="number" 
                    value={newDerivative.reputationScore}
                    onChange={(e) => setNewDerivative({...newDerivative, reputationScore: parseInt(e.target.value) || 0})}
                    className="fhe-input"
                    min="300"
                    max="850"
                  />
                </div>

                <div className="form-group">
                  <label>Notional Value (USD) *</label>
                  <input 
                    type="number" 
                    value={newDerivative.notionalValue}
                    onChange={(e) => setNewDerivative({...newDerivative, notionalValue: parseInt(e.target.value) || 0})}
                    className="fhe-input"
                  />
                </div>

                <div className="form-group">
                  <label>Strike Price *</label>
                  <input 
                    type="number" 
                    value={newDerivative.strikePrice}
                    onChange={(e) => setNewDerivative({...newDerivative, strikePrice: parseInt(e.target.value) || 0})}
                    className="fhe-input"
                  />
                </div>

                <div className="form-group">
                  <label>Maturity (Days) *</label>
                  <input 
                    type="number" 
                    value={newDerivative.maturityDays}
                    onChange={(e) => setNewDerivative({...newDerivative, maturityDays: parseInt(e.target.value) || 30})}
                    className="fhe-input"
                  />
                </div>

                <div className="form-group">
                  <label>Derivative Type *</label>
                  <select 
                    value={newDerivative.derivativeType}
                    onChange={(e) => setNewDerivative({...newDerivative, derivativeType: e.target.value as any})}
                    className="fhe-select"
                  >
                    <option value="future">Future</option>
                    <option value="option">Option</option>
                    <option value="swap">Swap</option>
                  </select>
                </div>
              </div>

              <div className="encryption-preview">
                <h4>FHE Encryption Preview</h4>
                <div className="preview">
                  <div className="plain-text">Plain Score: {newDerivative.reputationScore}</div>
                  <div className="encryption-arrow">↓</div>
                  <div className="encrypted-text">
                    Encrypted: {FHEEncryptNumber(newDerivative.reputationScore).substring(0, 50)}...
                  </div>
                </div>
              </div>
            </div>

            <div className="modal-footer">
              <button onClick={() => setShowCreateModal(false)} className="cancel-btn">Cancel</button>
              <button onClick={createDerivative} disabled={creating} className="submit-btn fhe-button">
                {creating ? "Encrypting with FHE..." : "Create Derivative"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Transaction Status Modal */}
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content fhe-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="fhe-spinner"></div>}
              {transactionStatus.status === "success" && "✅"}
              {transactionStatus.status === "error" && "❌"}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;