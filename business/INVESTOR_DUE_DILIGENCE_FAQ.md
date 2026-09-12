# Zanostack (GenOffice) — Investor Due Diligence FAQ

**Target Audience**: Venture Capitalists, Angel Investors, Technical Due Diligence Evaluators, Grant Committees.

---

## 1. Proprietary Status & Intellectual Property

### Q: Can Zanostack remain 100% proprietary and closed-source?
**A: Yes, absolutely.**  
* **Architecture Design**: Zanostack is developed under a clean-room modular architecture. The core application logic, shell IPC bridges, CRM pipeline, and compliance shredding engines are custom-written TypeScript and React code owned by the company.
* **Open-Source Separation**: The repository uses permissible MIT and Apache 2.0 licensed libraries (e.g., standard Vite, React, Tailwind, and permissible parser utilities). 
* **Zero AGPL Contamination**: Any third-party domain models referenced for accounting standards (e.g., standard double-entry bookkeeping rules or GAAP/IFRS balance sheet formulas) are clean-room implementations. In copyright law, financial accounting principles and mathematical formulas cannot be copyrighted. By authoring original TypeScript code rather than bundling copyleft binaries, Zanostack retains 100% proprietary commercial ownership.

---

## 2. Competitive Moat & Defense Against Big Tech

### Q: Why won't Microsoft (Office 365) or Google (Workspace) crush you?
**A: They are structurally misaligned to serve this specific market.**
1. **The Procurement Wedge**: Microsoft and Google build horizontal, generic office tools for everyone. They do not build statutory tender compliance catalogs, 90-day police stamp tracking, or RFP clause shredders. Tailoring their software to regional government procurement rules is outside their global enterprise focus.
2. **Cloud-Lock vs. Data Sovereignty**: Big Tech is fundamentally incentivized to lock customer data inside their US cloud platforms (Azure and Google Cloud) to drive cloud infrastructure consumption. Zanostack's core value proposition is **Local-First Sovereignty**—appealing directly to businesses that cannot or will not store sensitive commercial bids, client legal files, and financial records on public multi-tenant clouds.
3. **High-Density Desktop Integration**: In Microsoft 365, Word, Excel, Dynamics CRM, and PowerBI are massive, disconnected silos that require enterprise IT administrators and expensive monthly license tiers. Zanostack is an integrated, lightweight desktop application that works out of the box with zero IT configuration.

---

## 3. Unit Economics & Gross Margins

### Q: How does Zanostack achieve 90%–95% gross margins compared to 70% for traditional SaaS?
**A: By offloading compute to the edge (the user's laptop).**
* In typical cloud SaaS applications, the vendor pays escalating cloud bills for every document uploaded, every search executed, and every background task processed. AI-heavy SaaS companies frequently burn 30% to 50% of their revenue on GPU cloud instances.
* In Zanostack, the desktop application executes document parsing, PDF clause coordinate extraction, and local UI rendering directly on the user's CPU and RAM. 
* Our server-side costs are limited to simple license key verification and optional telemetry relays. This near-zero marginal cost of service allows us to operate at **92% to 96% gross margins**, enabling rapid profitability with minimal venture capital burn.

---

## 4. Scalability & Technical Stack

### Q: How does the technical architecture maintain high performance across multiple complex apps?
**A: Through a unified monorepo and isolated WebContentsView lifecycles.**
* **Stack**: Electron + React + TypeScript + Vite + Tailwind CSS.
* **Process Isolation**: Each tab in Zanostack (Docs, Sheets, CRM, Tenders) operates within its own isolated `WebContentsView`, preventing memory leaks in one document from affecting another.
* **Prewarming & Instant Switching**: The shell prewarms background engines and maintains instant tab switching, delivering a snappy desktop user experience far superior to browser-based web apps.
* **Verification Pipeline**: The codebase enforces 100% TypeScript typecheck compliance across all 21 monorepo packages, automated brand-check sweeps, and continuous build pipelines.

---

## 5. Monetization, Retention & Churn Defense

### Q: What prevents users from churning once they win a tender?
**A: The "Operating System Flywheel" creates deep software stickiness.**
* If Zanostack were merely a tender document reader, churn could be an issue. But Zanostack is a **complete business operating system**:
  1. Once a tender is won, the contractor manages the client relationship inside **CRM**.
  2. They draft project milestone claims and invoices inside **Finance**.
  3. They track job costing and bill-of-quantities in **Sheets**.
  4. They store company credentials, tax pins, and CIDB/B-BBEE certificates inside the **Vault**.
* Because their operational documents, customer records, and compliance credentials live in Zanostack, switching away entails severe friction. This creates strong negative net churn and high Customer Lifetime Value (LTV).

---

## 6. Regulatory & Privacy Compliance (POPIA / GDPR)

### Q: How does Zanostack handle data privacy regulations?
**A: Privacy is built into the architecture, not added as a compliance checklist.**
* Under data protection frameworks like South Africa’s **POPIA** (Protection of Personal Information Act) and Europe’s **GDPR**, companies face severe legal liability when transferring personal data to international cloud services.
* With Zanostack, customer data, director identification numbers, tax clearance certificates, and financial ledgers never leave the user's local disk unless the user explicitly exports them. Zanostack is compliant by default because the software vendor never takes custody of the user's data.
