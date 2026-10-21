import sidebar from '@tabler/icons/outline/layout-sidebar.svg';
import sidebarHidden from '@tabler/icons/outline/layout-sidebar-left-collapse.svg';
import sidebarMore from '@tabler/icons/outline/dots.svg';
import sidebarCompose from '@tabler/icons/outline/edit.svg';
import folder from '@tabler/icons/outline/folder.svg';
import folderOpen from '@tabler/icons/outline/folder-open.svg';
import pencil from '@tabler/icons/outline/pencil.svg';
import plus from '@tabler/icons/outline/plus.svg';
import settings from '@tabler/icons/outline/settings.svg';
import arrowUp from '@tabler/icons/outline/arrow-up.svg';
import arrowDown from '@tabler/icons/outline/arrow-down.svg';
import arrowLeft from '@tabler/icons/outline/arrow-left.svg';
import arrowRight from '@tabler/icons/outline/arrow-right.svg';
import square from '@tabler/icons/outline/square.svg';
import dots from '@tabler/icons/outline/dots.svg';
import copy from '@tabler/icons/outline/copy.svg';
import circle from '@tabler/icons/outline/circle.svg';
import photo from '@tabler/icons/outline/photo.svg';
import sliders from '@tabler/icons/outline/adjustments-horizontal.svg';
import cpu from '@tabler/icons/outline/cpu.svg';
import brain from '@tabler/icons/outline/brain.svg';
import gauge from '@tabler/icons/outline/gauge.svg';
import chevronRight from '@tabler/icons/outline/chevron-right.svg';
import check from '@tabler/icons/outline/check.svg';
import arrowsSort from '@tabler/icons/outline/arrows-sort.svg';
import ban from '@tabler/icons/outline/ban.svg';
import low from '@tabler/icons/outline/antenna-bars-2.svg';
import medium from '@tabler/icons/outline/antenna-bars-3.svg';
import high from '@tabler/icons/outline/antenna-bars-5.svg';
import bolt from '@tabler/icons/outline/bolt.svg';
import sparkles from '@tabler/icons/outline/sparkles.svg';
import circleCheck from '@tabler/icons/outline/circle-check.svg';
import circleX from '@tabler/icons/outline/circle-x.svg';
import loader from '@tabler/icons/outline/loader-2.svg';
import x from '@tabler/icons/outline/x.svg';
import tasks from '@tabler/icons/outline/list-check.svg';
import agents from '@tabler/icons/outline/users.svg';
import search from '@tabler/icons/outline/search.svg';
import refresh from '@tabler/icons/outline/refresh.svg';
import terminal from '@tabler/icons/outline/terminal-2.svg';
import code from '@tabler/icons/outline/code.svg';
import save from '@tabler/icons/outline/device-floppy.svg';
import trash from '@tabler/icons/outline/trash.svg';
import externalLink from '@tabler/icons/outline/external-link.svg';
import play from '@tabler/icons/outline/player-play.svg';
import warning from '@tabler/icons/outline/alert-triangle.svg';
import info from '@tabler/icons/outline/info-circle.svg';
import fileSearch from '@tabler/icons/outline/file-search.svg';
import filePlus from '@tabler/icons/outline/file-plus.svg';
import clock from '@tabler/icons/outline/clock.svg';
import helpCircle from '@tabler/icons/outline/help-circle.svg';
import worldSearch from '@tabler/icons/outline/world-search.svg';
import browser from '@tabler/icons/outline/browser.svg';
import book from '@tabler/icons/outline/book.svg';
import tool from '@tabler/icons/outline/tool.svg';

const icons = {
  sidebar, 'sidebar-hidden': sidebarHidden, 'sidebar-more': sidebarMore, 'sidebar-compose': sidebarCompose,
  folder, 'folder-open': folderOpen, plus, settings,
  'project-folder': folder, 'project-folder-open': folderOpen,
  'arrow-up': arrowUp, 'arrow-down': arrowDown, 'arrow-left': arrowLeft, 'arrow-right': arrowRight,
  stop: square, more: dots, copy, circle, image: photo, close: x, sliders, model: cpu,
  thinking: brain, context: gauge, 'chevron-right': chevronRight, check,
  inherit: arrowsSort, off: ban, low, medium, high, xhigh: bolt, max: sparkles,
  'circle-check': circleCheck, 'circle-x': circleX, 'loader-circle': loader,
  tasks, agents, search, refresh, terminal, code, save, trash, edit: pencil, 'external-link': externalLink, play, warning, info,
  'file-search': fileSearch, 'file-plus': filePlus, clock, question: helpCircle,
  'world-search': worldSearch, browser, book, tool,
};
const templates = new Map<keyof typeof icons, SVGSVGElement>();

export function icon(name: keyof typeof icons): SVGElement {
  let svg = templates.get(name);
  if (!svg) {
    const template = document.createElement('template');
    template.innerHTML = icons[name];
    const source = template.content.firstElementChild;
    if (!(source instanceof SVGSVGElement)) throw new Error(`Invalid bundled icon: ${name}`);
    source.setAttribute('class', 'ui-icon'); source.setAttribute('aria-hidden', 'true');
    source.setAttribute('width', '16'); source.setAttribute('height', '16'); source.setAttribute('stroke-width', '1.75');
    templates.set(name, source); svg = source;
  }
  return document.importNode(svg, true);
}

const toolIcons: Readonly<Record<string, keyof typeof icons | undefined>> = {
  read: 'file-search',
  write: 'file-plus',
  edit: 'edit',
  glob: 'folder',
  grep: 'search',
  bash: 'terminal',
  eval: 'code',
  ask: 'question',
  task: 'agents',
  wait: 'clock',
  web_search: 'world-search',
  browser: 'browser',
  learn: 'book',
  manage_skill: 'settings',
};

export function toolIcon(name: string): SVGElement {
  return icon(Object.hasOwn(toolIcons, name) ? toolIcons[name] ?? 'tool' : 'tool');
}

export function statusIcon(status: string): SVGElement {
  switch (status) {
    case 'completed': case 'succeeded': return icon('circle-check');
    case 'failed': case 'error': case 'aborted': case 'interrupted': case 'cancelled': return icon('circle-x');
    case 'active': case 'running': case 'started': return icon('loader-circle');
    default: return icon('circle');
  }
}
