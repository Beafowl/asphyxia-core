import { Router } from 'express';
import { ASSETS_PATH } from '../utils/EamuseIO';

export const webui = Router();
webui.get('/', async (req, res) => {
  res.render('index');
});
