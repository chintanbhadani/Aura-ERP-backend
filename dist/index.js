"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const inventory_routes_1 = __importDefault(require("./routes/inventory.routes")); // TS should resolve this to inventory.routes.ts
const app = (0, express_1.default)();
const PORT = process.env.PORT || 4000;
app.use((0, cors_1.default)());
app.use(express_1.default.json());
const auth_routes_1 = __importDefault(require("./routes/auth.routes"));
const supplier_routes_1 = __importDefault(require("./routes/supplier.routes"));
const category_routes_1 = __importDefault(require("./routes/category.routes"));
// Routes setup
app.get('/health', (req, res) => {
    res.json({ status: 'OK', message: 'Inventory Management API Running' });
});
app.use('/api/auth', auth_routes_1.default);
app.use('/api/inventory', inventory_routes_1.default);
app.use('/api/suppliers', supplier_routes_1.default);
app.use('/api/categories', category_routes_1.default);
// Global Error Handler
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Something went wrong!' });
});
app.listen(PORT, () => {
    console.log(`HTTP API Server running on port ${PORT}`);
});
