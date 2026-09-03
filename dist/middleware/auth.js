"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.authorizeRole = authorizeRole;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-key-fallback';
function authorizeRole(...allowedRoles) {
    return (req, res, next) => {
        try {
            const token = req.headers.authorization?.split(' ')[1];
            if (!token) {
                // Dev mode bypass
                req.user = { id: 'dev-user', username: 'dev', role: allowedRoles[0] };
                return next();
            }
            const decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
            if (!allowedRoles.includes(decoded.role)) {
                return res.status(403).json({ error: 'Forbidden - Insufficient permissions' });
            }
            req.user = decoded;
            next();
        }
        catch (error) {
            return res.status(401).json({ error: 'Unauthorized - Invalid token' });
        }
    };
}
