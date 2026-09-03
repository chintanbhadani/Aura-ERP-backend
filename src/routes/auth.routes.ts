import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';

const router = Router();
const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-key-fallback';

// Login User
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body; // Frontend sends email in Login.tsx
    
    // Fallback if they passed username
    const identifier = email || req.body.username;

    const user = await prisma.user.findUnique({
      where: { username: identifier }
    });

    if (!user || user.password !== password) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: '1d' }
    );

    res.json({
      user: { id: user.id, username: user.username, role: user.role, name: user.name, email: user.email },
      token
    });
  } catch (error) {
    res.status(500).json({ error: 'Login failed' });
  }
});

// Signup User
router.post('/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body;

    const existingUser = await prisma.user.findUnique({
      where: { username: email }
    });

    if (existingUser) {
      return res.status(400).json({ error: 'User already exists' });
    }

    const user = await prisma.user.create({
      data: {
        username: email,
        email,
        password,
        name,
        role: 'PLANT_ADMIN'
      }
    });

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: '1d' }
    );

    res.json({
      user: { id: user.id, username: user.username, role: user.role, name: user.name, email: user.email },
      token
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Signup failed' });
  }
});

// Get Current User Profile
router.get('/me', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token' });

    const token = authHeader.split(' ')[1];
    const decoded: any = jwt.verify(token, JWT_SECRET);

    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: { id: true, username: true, role: true, name: true, email: true }
    });

    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

export default router;
