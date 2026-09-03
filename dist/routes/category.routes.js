"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const client_1 = require("@prisma/client");
const router = (0, express_1.Router)();
const prisma = new client_1.PrismaClient();
// GET all categories
router.get('/', async (req, res) => {
    try {
        const categories = await prisma.category.findMany({
            orderBy: { name: 'asc' }
        });
        res.json(categories);
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to fetch categories' });
    }
});
// POST new category
router.post('/', async (req, res) => {
    try {
        const { name } = req.body;
        if (!name)
            return res.status(400).json({ error: 'Name is required' });
        const category = await prisma.category.create({
            data: { name }
        });
        res.status(201).json(category);
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to create category' });
    }
});
exports.default = router;
