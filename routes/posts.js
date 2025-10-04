const express = require('express');
const router = express.Router();
const { prisma } = require('../lib/prisma');

async function getUser(req) {
  const token = req.cookies?.l4_session;
  if (!token) return null;
  const session = await prisma.session.findUnique({ where: { token }, include: { user: true } });
  if (!session || session.expiresAt < new Date()) return null;
  return session.user;
}

router.get('/', async (req, res) => {
  const posts = await prisma.post.findMany({ orderBy: { createdAt: 'desc' }, include: { author: true, _count: { select: { likes: true, comments: true } } }, take: 50 });
  res.json({ posts });
});

router.post('/', async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { content } = req.body || {};
  if (!content) return res.status(400).json({ error: 'content required' });
  const post = await prisma.post.create({ data: { content, authorId: user.id } });
  res.json({ post });
});

router.get('/:id/comments', async (req, res) => {
  const comments = await prisma.comment.findMany({ where: { postId: req.params.id }, include: { author: true }, orderBy: { createdAt: 'asc' } });
  res.json({ comments });
});

router.post('/:id/comments', async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const { content } = req.body || {};
  if (!content) return res.status(400).json({ error: 'content required' });
  const comment = await prisma.comment.create({ data: { content, postId: req.params.id, authorId: user.id } });
  res.json({ comment });
});

router.post('/:id/likes', async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const like = await prisma.like.create({ data: { postId: req.params.id, userId: user.id } });
    res.json({ like });
  } catch (e) {
    res.status(409).json({ error: 'Already liked' });
  }
});

router.delete('/:id/likes', async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  await prisma.like.deleteMany({ where: { postId: req.params.id, userId: user.id } });
  res.json({ ok: true });
});

module.exports = router;


