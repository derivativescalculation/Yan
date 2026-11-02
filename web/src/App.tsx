import { lazy, Suspense } from "react";
import { Routes, Route } from "react-router-dom";
import { Shell } from "./components/Shell";
import Home from "./pages/Home";
import Mine from "./pages/Mine";
import Agent from "./pages/Agent";
import Treasury from "./pages/Treasury";
import Docs from "./pages/Docs";
import NotFound from "./pages/NotFound";
import { UpdateBanner } from "./components/UpdateBanner";

// three.js only loads with the raffle page
const Raffle = lazy(() => import("./pages/Raffle"));

export default function App() {
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/mine" element={<Mine />} />
        <Route path="/raffle" element={<Suspense fallback={<div style={{ minHeight: "100vh" }} />}><Raffle /></Suspense>} />
        <Route path="/agent" element={<Agent />} />
        <Route path="/agent/:id" element={<Agent />} />
        <Route path="/treasury" element={<Treasury />} />
        <Route path="/docs" element={<Docs />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
      <UpdateBanner />
    </Shell>
  );
}
