"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const client_1 = require("@prisma/client");
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
                supplier: true
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
exports.default = router;
