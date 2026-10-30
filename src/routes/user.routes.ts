import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';

const router = Router();
const prisma = new PrismaClient();

// Helper to format user for frontend UserRecord
function formatUser(u: any) {
  return {
    id: u.id,
    employeeId: u.employeeId || `EMP-${u.id.slice(0, 6).toUpperCase()}`,
    username: u.username,
    fullName: u.name || u.username,
    email: u.email || '',
    contactNumber: u.contactNumber || '',
    role: u.role || 'Admin',
    status: u.status || 'Active',
    isBlock: Boolean(u.isBlock),
    imageUrl: u.imageUrl || '',
    twoFactorEnabled: u.twoFactorEnabled !== false,
    isTwoFactorSetup: Boolean(u.isTwoFactorSetup),
    attachments: Array.isArray(u.attachments) ? u.attachments : [],
    createdAt: u.createdAt,
    updatedAt: u.updatedAt
  };
}

// GET all users
router.get('/', async (req: Request, res: Response) => {
  try {
    const { search, role, status } = req.query;

    const where: any = {};
    const andFilters: any[] = [];

    if (search) {
      const q = String(search).trim();
      andFilters.push({
        OR: [
          { username: { contains: q, mode: 'insensitive' } },
          { name: { contains: q, mode: 'insensitive' } },
          { email: { contains: q, mode: 'insensitive' } },
          { employeeId: { contains: q, mode: 'insensitive' } },
          { contactNumber: { contains: q, mode: 'insensitive' } }
        ]
      });
    }

    if (role && role !== 'ALL') {
      andFilters.push({
        role: { equals: String(role), mode: 'insensitive' }
      });
    }

    if (status && status !== 'ALL') {
      andFilters.push({
        status: { equals: String(status), mode: 'insensitive' }
      });
    }

    if (andFilters.length > 0) {
      where.AND = andFilters;
    }

    const users = await prisma.user.findMany({
      where,
      orderBy: { updatedAt: 'desc' }
    });

    res.json(users.map(formatUser));
  } catch (error: any) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// GET user by ID
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { id },
          { username: id },
          { employeeId: id }
        ]
      }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(formatUser(user));
  } catch (error: any) {
    console.error('Error fetching user by id:', error);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// POST create user
router.post('/', async (req: Request, res: Response) => {
  try {
    const {
      username,
      fullName,
      name,
      email,
      contactNumber,
      password,
      role,
      status,
      employeeId,
      imageUrl,
      isBlock,
      twoFactorEnabled,
      attachments
    } = req.body;

    if (!username || !username.trim()) {
      return res.status(400).json({ error: 'Username is required' });
    }

    const cleanUsername = username.trim().toLowerCase();

    const existing = await prisma.user.findFirst({
      where: {
        OR: [
          { username: cleanUsername },
          ...(email ? [{ email: email.trim().toLowerCase() }] : [])
        ]
      }
    });

    if (existing) {
      return res.status(400).json({ error: 'Username or email already in use' });
    }

    const created = await prisma.user.create({
      data: {
        username: cleanUsername,
        name: fullName || name || username,
        email: email ? email.trim().toLowerCase() : null,
        contactNumber: contactNumber || null,
        password: password || 'Default@123',
        role: role || 'Admin',
        status: status || 'Active',
        employeeId: employeeId || `EMP-${Date.now().toString().slice(-5)}`,
        imageUrl: imageUrl || null,
        isBlock: Boolean(isBlock),
        twoFactorEnabled: twoFactorEnabled !== false,
        attachments: attachments || []
      }
    });

    res.status(201).json(formatUser(created));
  } catch (error: any) {
    console.error('Error creating user:', error);
    res.status(500).json({ error: error.message || 'Failed to create user' });
  }
});

// PUT update user
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const {
      fullName,
      name,
      email,
      contactNumber,
      password,
      role,
      status,
      employeeId,
      imageUrl,
      isBlock,
      twoFactorEnabled,
      attachments
    } = req.body;

    const dataToUpdate: any = {};
    if (fullName !== undefined || name !== undefined) dataToUpdate.name = fullName || name;
    if (email !== undefined) dataToUpdate.email = email ? email.trim().toLowerCase() : null;
    if (contactNumber !== undefined) dataToUpdate.contactNumber = contactNumber;
    if (password && password.trim() !== '') dataToUpdate.password = password;
    if (role !== undefined) dataToUpdate.role = role;
    if (status !== undefined) dataToUpdate.status = status;
    if (employeeId !== undefined) dataToUpdate.employeeId = employeeId;
    if (imageUrl !== undefined) dataToUpdate.imageUrl = imageUrl;
    if (isBlock !== undefined) dataToUpdate.isBlock = Boolean(isBlock);
    if (twoFactorEnabled !== undefined) dataToUpdate.twoFactorEnabled = Boolean(twoFactorEnabled);
    if (attachments !== undefined) dataToUpdate.attachments = attachments;

    const updated = await prisma.user.update({
      where: { id },
      data: dataToUpdate
    });

    res.json(formatUser(updated));
  } catch (error: any) {
    console.error('Error updating user:', error);
    res.status(500).json({ error: error.message || 'Failed to update user' });
  }
});

// PATCH toggle block
router.patch('/:id/toggle-block', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: 'User not found' });
    }

    const updated = await prisma.user.update({
      where: { id },
      data: { isBlock: !existing.isBlock }
    });

    res.json({ id: updated.id, isBlock: Boolean(updated.isBlock) });
  } catch (error: any) {
    console.error('Error toggling block user:', error);
    res.status(500).json({ error: 'Failed to toggle block status' });
  }
});

// POST reset 2FA
router.post('/:id/reset-2fa', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await prisma.user.update({
      where: { id },
      data: { isTwoFactorSetup: false }
    });
    res.json({ success: true, message: 'Google Authenticator reset successfully' });
  } catch (error: any) {
    console.error('Error resetting 2FA:', error);
    res.status(500).json({ error: 'Failed to reset 2FA' });
  }
});

// POST change password
router.post('/:id/change-password', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { password } = req.body;
    if (!password || password.length < 4) {
      return res.status(400).json({ error: 'Password must be at least 4 characters long' });
    }

    await prisma.user.update({
      where: { id },
      data: { password }
    });

    res.json({ success: true, message: 'Password changed successfully' });
  } catch (error: any) {
    console.error('Error changing password:', error);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

// DELETE user
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await prisma.user.delete({ where: { id } });
    res.json({ message: 'User deleted successfully' });
  } catch (error: any) {
    console.error('Error deleting user:', error);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

export default router;
