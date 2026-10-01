import { render } from 'preact';
import { App } from './ui/app';
import './ui/style.css';

render(<App />, document.getElementById('ui')!);
