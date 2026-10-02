# Budgt

A clean, minimalist budgeting app for saving and financial security. No subscription, no account, no build step.

## What it does

- **Dashboard:** left to spend, spending this month vs last month, income vs spending over six months, budget by category, upcoming bills and your savings outlook.
- **Transactions:** add expenses and income, and optionally itemize a receipt into its line items. Search covers merchants, notes and receipt items. **Import CSV** reads a bank export in the browser, guesses categories from your past entries, and skips rows you already have.
- **Budget:** set a monthly limit per category and watch progress update as you spend.
- **Paychecks:** enter each income source with how often it pays (weekly, every 2 weeks, twice a month or monthly) and the next payday. Starting from today's balance, each paycheck is matched to the bills due before the next one, takes its share of savings, and shows what's free to spend until the next payday. A paycheck that can't cover its bills holds money back from the one before it.
- **Bills & debt:** track recurring bills and debts (balance, APR, payment, due day). Mark a bill paid to log it, and see a payoff date for each debt. **Yearly costs** (insurance, gifts, repairs) are split into a monthly amount to set aside.
- **Goals:** set savings goals with an optional target date and monthly contribution, and see whether you're on track. At the start of each month the dashboard offers to move last month's leftover budget into a goal.

Data is stored in your browser's localStorage and never leaves your device. Every change saves as you type, including half-filled forms, which reopen as you left them after a reload. Open tabs stay in sync with each other. Use **Export backup** / **Import backup** in the sidebar to move data between browsers or keep a copy; clearing site data or using a private window will erase it.

## Running it

It's plain HTML, CSS and JavaScript (`index.html`, `assets/`). Open `index.html` in a browser, or run `python3 -m http.server` and visit http://localhost:8000.

### Hosting on GitHub Pages

1. Go to **Settings → Pages** in this repository.
2. Set **Source** to "Deploy from a branch", pick the branch that holds `index.html` and the `/ (root)` folder, then save.
3. After a minute the app is live at `https://keganberg.github.io/Budgt/`.

## Credits

Icons are from [Lucide](https://lucide.dev) (ISC licence), copied inline. Last month's chart line colour was checked for contrast with [Adobe Leonardo](https://leonardocolor.io).
