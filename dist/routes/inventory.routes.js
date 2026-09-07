"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const client_1 = require("@prisma/client");
const multer_1 = __importDefault(require("multer"));
const xlsx = __importStar(require("xlsx"));
const logger_1 = __importDefault(require("../utils/logger"));
const upload = (0, multer_1.default)({ storage: multer_1.default.memoryStorage() });
const router = (0, express_1.Router)();
const prisma = new client_1.PrismaClient();
// GET all items (with optional search)
router.get('/', async (req, res) => {
    try {
        const { search } = req.query;
        const products = await prisma.product.findMany({
            where: search
                ? {
                    OR: [
                        { name: { contains: search, mode: 'insensitive' } },
                        { sku: { contains: search, mode: 'insensitive' } },
                    ],
                }
                : undefined,
            include: {
                category: true,
                supplier: true,
                unit: true
            },
            orderBy: { createdAt: 'desc' }
        });
        res.json(products);
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to fetch inventory' });
    }
});
// POST new item
router.post('/', async (req, res) => {
    try {
        const data = req.body;
        // Basic validation
        if (!data.sku || !data.name || data.quantity === undefined || !data.cost_price || !data.selling_price || !data.categoryId || !data.supplierId) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        const product = await prisma.product.create({
            data: {
                sku: data.sku,
                name: data.name,
                quantity: parseInt(data.quantity),
                cost_price: parseFloat(data.cost_price),
                selling_price: parseFloat(data.selling_price),
                min_stock: parseInt(data.min_stock) || 0,
                categoryId: data.categoryId,
                supplierId: data.supplierId,
                unitId: data.unitId || null,
                location: data.location || '',
                status: data.status || 'Active',
            },
        });
        res.status(201).json(product);
    }
    catch (error) {
        if (error.code === 'P2002') {
            return res.status(409).json({ error: 'SKU must be unique' });
        }
        res.status(500).json({ error: 'Failed to create product' });
    }
});
// PUT update item
router.put('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const data = req.body;
        const product = await prisma.product.update({
            where: { id },
            data: {
                sku: data.sku,
                name: data.name,
                quantity: data.quantity !== undefined ? parseInt(data.quantity) : undefined,
                cost_price: data.cost_price !== undefined ? parseFloat(data.cost_price) : undefined,
                selling_price: data.selling_price !== undefined ? parseFloat(data.selling_price) : undefined,
                min_stock: data.min_stock !== undefined ? parseInt(data.min_stock) : undefined,
                categoryId: data.categoryId,
                supplierId: data.supplierId,
                unitId: data.unitId || null,
                location: data.location,
                status: data.status,
            },
        });
        res.json(product);
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to update product' });
    }
});
// DELETE item
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await prisma.product.delete({
            where: { id },
        });
        res.status(204).send();
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to delete product' });
    }
});
// POST bulk upload
router.post('/bulk-upload', upload.single('file'), async (req, res) => {
    try {
        console.log(" call bulk-upload :: ");
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const rows = xlsx.utils.sheet_to_json(sheet);
        let successCount = 0;
        const errors = [];
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            try {
                // Validation
                if (!row.sku || !row.name || row.quantity === undefined || !row.cost_price || !row.selling_price || !row.categoryName || !row.supplierName) {
                    errors.push(`Row ${i + 2}: Missing required fields`);
                    continue;
                }
                // Find or create Category
                let category = await prisma.category.findFirst({ where: { name: row.categoryName } });
                if (!category) {
                    category = await prisma.category.create({ data: { name: row.categoryName } });
                }
                // Find or create Supplier
                let supplier = await prisma.supplier.findFirst({ where: { name: row.supplierName } });
                if (!supplier) {
                    supplier = await prisma.supplier.create({ data: { name: row.supplierName } });
                }
                // Find or create Unit
                let unit = null;
                if (row.unitName) {
                    unit = await prisma.unit.findFirst({ where: { name: row.unitName } });
                    if (!unit) {
                        unit = await prisma.unit.create({ data: { name: row.unitName } });
                    }
                }
                // Upsert Product
                await prisma.product.upsert({
                    where: { sku: row.sku.toString() },
                    update: {
                        name: row.name,
                        quantity: parseInt(row.quantity),
                        cost_price: parseFloat(row.cost_price),
                        selling_price: parseFloat(row.selling_price),
                        min_stock: parseInt(row.min_stock) || 0,
                        categoryId: category.id,
                        supplierId: supplier.id,
                        unitId: unit?.id || null,
                        location: row.location || '',
                        status: row.status || 'Active',
                    },
                    create: {
                        sku: row.sku.toString(),
                        name: row.name,
                        quantity: parseInt(row.quantity),
                        cost_price: parseFloat(row.cost_price),
                        selling_price: parseFloat(row.selling_price),
                        min_stock: parseInt(row.min_stock) || 0,
                        categoryId: category.id,
                        supplierId: supplier.id,
                        unitId: unit?.id || null,
                        location: row.location || '',
                        status: row.status || 'Active',
                    },
                });
                successCount++;
            }
            catch (err) {
                errors.push(`Row ${i + 2}: ${err.message}`);
            }
        }
        res.json({ message: `Successfully processed ${successCount} rows.`, errors });
    }
    catch (error) {
        logger_1.default.error('Bulk upload error', { error });
        res.status(500).json({ error: 'Failed to process bulk upload' });
    }
});
exports.default = router;
