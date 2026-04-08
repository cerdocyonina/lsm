import "bootstrap/dist/css/bootstrap.min.css";
import React from "react";
import ReactDOM from "react-dom/client";
import { Toaster } from "react-hot-toast";
import App from "./App";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <>
      <App />
      <Toaster
        position="top-center"
        toastOptions={{
          duration: 2500,
        }}
      />
    </>
  </React.StrictMode>,
);
