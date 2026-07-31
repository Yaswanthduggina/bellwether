// The shell: masthead, navigation, theme toggle, and the health check.
//
// The health banner exists because the single most likely thing to go wrong in a
// clean clone is that the API is not running or DATABASE_URL is unset — and the
// failure mode without it is a page of empty panels that reads as "there is no
// data" rather than "nothing is connected". The banner names what to do.

import { useEffect, useState } from "react";
import "./App.css";
import { api } from "./api/client";
import { Notice } from "./components/ui";
import { useAsync } from "./hooks/useAsync";
import { Accounts } from "./pages/Accounts";
import { Dashboard } from "./pages/Dashboard";

type Page = "dashboard" | "accounts";

/**
 * Light default, and the choice is remembered.
 *
 * Light rather than the OS preference because the primary artefact here is a
 * briefing that gets screenshotted and printed. An explicit choice wins over
 * both.
 */
function useTheme(): [string, () => void] {
    const [theme, setTheme] = useState<string>(() => localStorage.getItem("bellwether-theme") ?? "light");

    useEffect(() => {
        document.documentElement.setAttribute("data-theme", theme);
        localStorage.setItem("bellwether-theme", theme);
    }, [theme]);

    return [theme, () => setTheme((current) => (current === "light" ? "dark" : "light"))];
}

function HealthBanner() {
    const health = useAsync(() => api.health(), []);

    if (health.loading) return null;

    if (health.error) {
        return (
            <Notice kind="bad">
                <strong>The API is not reachable.</strong> {health.error.message}
            </Notice>
        );
    }

    if (health.data !== null && health.data.database !== "reachable") {
        return (
            <Notice kind="bad">
                <strong>The API is up but the database is not.</strong> {health.data.message}
            </Notice>
        );
    }

    return null;
}

export default function App() {
    const [theme, toggleTheme] = useTheme();
    const [page, setPage] = useState<Page>("dashboard");

    return (
        <div className="shell">
            <header className="masthead">
                <h1>Bellwether</h1>
                <span className="kicker">Competitive briefing</span>
                <span className="spacer" />
                <nav className="nav">
                    <button className={page === "dashboard" ? "active" : ""} onClick={() => setPage("dashboard")}>
                        Dashboard
                    </button>
                    <button className={page === "accounts" ? "active" : ""} onClick={() => setPage("accounts")}>
                        Accounts
                    </button>
                </nav>
                <button
                    className="icon-button"
                    onClick={toggleTheme}
                    title={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
                    aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
                >
                    {theme === "light" ? "◐ Dark" : "◑ Light"}
                </button>
            </header>
            <div className="masthead-rule" />

            <HealthBanner />

            <main>{page === "dashboard" ? <Dashboard /> : <Accounts />}</main>
        </div>
    );
}
