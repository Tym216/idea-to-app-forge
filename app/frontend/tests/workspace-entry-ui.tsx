import React from 'react';
import {createRoot} from 'react-dom/client';
import {MemoryRouter,Routes,Route} from 'react-router-dom';
import Workspace from '../src/pages/Workspace';
createRoot(document.getElementById('root')!).render(<MemoryRouter initialEntries={['/project/p']}><Routes><Route path="/project/:projectId" element={<Workspace/>}/></Routes></MemoryRouter>);
