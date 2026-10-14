import React from 'react';
import {createRoot} from 'react-dom/client';
import {useAppState} from 'virtual:forge-hook';
function Game(){
 const game=useAppState('game',{initialValue:{score:0,snake:[[1,1]],direction:'right'}});
 return <div><output data-testid="game">{JSON.stringify(game.value)}</output><output data-testid="status">{game.status}</output>
 <button onClick={()=>game.setValue(v=>({...v,score:v.score+10,snake:[[v.snake[0][0]+1,1]],direction:'up'}))}>Play</button>
 <button onClick={()=>{if(confirm('重置业务数据？'))game.reset();}}>重置业务数据</button></div>;
}
function App(){
 const [loggedIn,setLoggedIn]=React.useState(true);
 return <><button onClick={()=>{localStorage.removeItem('auth-session');setLoggedIn(false);}}>Logout</button>
 <button onClick={()=>setLoggedIn(true)}>Login</button>{loggedIn&&<Game/>}</>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
