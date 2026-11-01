import { Routes, Route } from "react-router-dom";
import { Shell } from "./components/Shell";
import Home from "./pages/Home";
import Mine from "./pages/Mine";
import Agent from "./pages/Agent";
import Treasury from "./pages/Treasury";
import Docs from "./pages/Docs";

export default function App() {
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/mine" element={<Mine />} />
        <Route path="/agent" element={<Agent />} />
        <Route path="/agent/:id" element={<Agent />} />
        <Route path="/treasury" element={<Treasury />} />
        <Route path="/docs" element={<Docs />} />
      </Routes>
    </Shell>
  );
}
