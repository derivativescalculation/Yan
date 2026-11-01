import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { wagmiConfig } from "./chain";
import { I18n } from "./i18n";
import App from "./App";
import "./styles/global.css";

const qc = new QueryClient({ defaultOptions: { queries: { refetchInterval: 15_000, staleTime: 10_000, retry: 1 } } });

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={qc}>
        <I18n>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </I18n>
      </QueryClientProvider>
    </WagmiProvider>
  </React.StrictMode>,
);
