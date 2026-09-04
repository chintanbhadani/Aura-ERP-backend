"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const client_1 = require("@prisma/client");
const router = (0, express_1.Router)();
const prisma = new client_1.PrismaClient();
// GET all suppliers
router.get('/', async (req, res) => {
    try {
        const suppliers = await prisma.supplier.findMany({
            orderBy: { name: 'asc' }
        });
        res.json(suppliers);
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to fetch suppliers' });
    }
});
// POST new supplier
router.post('/', async (req, res) => {
    try {
        const { name, contact, email } = req.body;
        if (!name)
            return res.status(400).json({ error: 'Name is required' });
        const supplier = await prisma.supplier.create({
            data: { name, contact, email }
        });
        res.status(201).json(supplier);
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to create supplier' });
    }
});
// PUT update supplier
router.put('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, contact, email } = req.body;
        if (!name)
            return res.status(400).json({ error: 'Name is required' });
        const supplier = await prisma.supplier.update({
            where: { id },
            data: { name, contact, email }
        });
        res.json(supplier);
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to update supplier' });
    }
});
// DELETE supplier
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await prisma.supplier.delete({
            where: { id }
        });
        res.status(204).send();
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to delete supplier' });
    }
});
exports.default = router;
