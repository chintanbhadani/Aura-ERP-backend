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
exports.default = router;
