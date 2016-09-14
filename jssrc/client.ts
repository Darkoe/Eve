import {clone, debounce, sortComparator} from "./util";
import {sentInputValues, activeIds, renderRecords, renderEve} from "./renderer"
import {handleEditorParse} from "./editor"

import {IndexScalar, IndexList, EAV, Record} from "./db"

//---------------------------------------------------------
// Utilities
//---------------------------------------------------------
function safeEav(eav:[any, any, any]):EAV {
  if(eav[0].type == "uuid")  {
    eav[0] = `⦑${eav[0].value}⦒`
  }
  if(eav[1].type == "uuid")  {
    eav[1] = `⦑${eav[1].value}⦒`
  }
  if(eav[2].type == "uuid")  {
    eav[2] = `⦑${eav[2].value}⦒`
  }
  return eav;
}

//---------------------------------------------------------
// Connect the websocket, send the ui code
//---------------------------------------------------------
export var DEBUG:string|boolean = false;

export var indexes = {
  records: new IndexScalar<Record>(), // E -> Record
  dirty: new IndexList<string>(),     // E -> A
  byName: new IndexList<string>(),    // name -> E
  byTag: new IndexList<string>(),     // tag -> E

  // renderer indexes
  byClass: new IndexList<string>(),   // class -> E
  byStyle: new IndexList<string>(),   // style -> E
  byChild: new IndexScalar<string>()  // child -> E
};

function handleDiff(state, diff) {
  let diffEntities = 0;
  let entitiesWithUpdatedValues = {};

  let records = indexes.records;
  let dirty = indexes.dirty;

  for(let remove of diff.remove) {
    let [e, a, v] = safeEav(remove);
    if(!records.index[e]) {
      console.error(`Attempting to remove an attribute of an entity that doesn't exist: ${e}`);
      continue;
    }

    let entity = records.index[e];
    let values = entity[a];
    if(!values) continue;
    dirty.insert(e, a);

    if(values.length <= 1 && values[0] === v) {
      delete entity[a];
    } else {
      let ix = values.indexOf(v);
      if(ix === -1) continue;
      values.splice(ix, 1);
    }

    // Update indexes
    if(a === "tag") indexes.byTag.remove(v, e);
    else if(a === "name") indexes.byName.remove(v, e);
    else if(a === "class") indexes.byClass.remove(v, e);
    else if(a === "style") indexes.byStyle.remove(v, e);
    else if(a === "children") indexes.byChild.remove(v, e);
    else if(a === "value") entitiesWithUpdatedValues[e] = true;

  }

  for(let insert of diff.insert) {
    let [e, a, v] = safeEav(insert);
    let entity = records.index[e];
    if(!entity) {
      entity = {};
      records.insert(e, entity);
      diffEntities++; // Nuke this and use records.dirty
    }

    dirty.insert(e, a);

    if(!entity[a]) entity[a] = [];
    entity[a].push(v);

    // Update indexes
    if(a === "tag") indexes.byTag.insert(v, e);
    else if(a === "name") indexes.byName.insert(v, e);
    else if(a === "class") indexes.byClass.insert(v, e);
    else if(a === "style") indexes.byStyle.insert(v, e);
    else if(a === "children") indexes.byChild.insert(v, e);
    else if(a === "value") entitiesWithUpdatedValues[e] = true;
  }

  // Update value syncing
  for(let e in entitiesWithUpdatedValues) {
    let a = "value";
    let entity = records.index[e];
    if(!entity[a]) {
      sentInputValues[e] = [];
    } else {
      if(entity[a].length > 1) console.error("Unable to set 'value' multiple times on entity", e, entity[a]);
      let value = entity[a][0];
      let sent = sentInputValues[e];
      if(sent && sent[0] === value) {
        dirty.remove(e, a);
        sent.shift();
      } else {
        sentInputValues[e] = [];
      }
    }
  }
  // Trigger all the subscribers of dirty indexes
  for(let indexName in indexes) {
    indexes[indexName].dispatchIfDirty();
  }
  // Clear dirty states afterwards so a subscriber of X can see the dirty state of Y reliably
  for(let indexName in indexes) {
    indexes[indexName].clearDirty();
  }
  // Finally, wipe the dirty E -> A index
  indexes.dirty.clearIndex();
}

let prerendering = false;
var frameRequested = false;

var socket = new WebSocket("ws://" + window.location.host +"/ws");
socket.onmessage = function(msg) {
  let data = JSON.parse(msg.data);
  if(data.type == "result") {
    let state = {entities: indexes.records.index, dirty: indexes.dirty.index};
    handleDiff(state, data);

    let diffEntities = 0;
    if(DEBUG) {
      console.groupCollapsed(`Received Result +${data.insert.length}/-${data.remove.length} (∂Entities: ${diffEntities})`);
      if(DEBUG === true || DEBUG === "diff") {
        console.table(data.insert);
        console.table(data.remove);
      }
      if(DEBUG === true || DEBUG === "state") {
        // we clone here to keep the entities fresh when you want to thumb through them in the log later (since they are rendered lazily)
        let copy = clone(state.entities);

        console.log("Entities", copy);
        console.log("Indexes", indexes);
      }
      console.groupEnd();
    }

    if(document.readyState === "complete") {
      renderEve();
    } else if(!prerendering) {
      prerendering = true;
      document.addEventListener("DOMContentLoaded", function() {
        renderEve();
      });
    }

  } else if(data.type == "error") {
    console.error(data.message, data);
  }
}
socket.onopen = function() {
  console.log("Connected to eve server!");
  onHashChange({});
}
socket.onclose = function() {
  console.log("Disconnected from eve server!");
}

//---------------------------------------------------------
// Bootstrapping interface
//---------------------------------------------------------
interface Block {id: string, name: string, sort: number, line: number};
interface Token {id: string, type: string, sort: number, line: number, surrogateOffset: number, surrogateLength: number};
type Line = Token[]

interface ParseInfo {
  blocks:Block[],
  blockIds:{[id:string]: Block},
  lines:Line[],
  tokenIds:{[id:string]: Token},
}
export var parseInfo:ParseInfo = {blocks: [], lines: [], blockIds: {}, tokenIds: {}};

let updateEditorParse = debounce(handleEditorParse, 1); // @FIXME: We need to listen for any changes to records with those tags



function tokensToParseInfo(tokenIds) {
  let records = indexes.records.index;

  // @FIXME: we don't want to be incremental right now, it's tough.
  tokenIds = indexes.byTag.index["token"];

  let lines:Token[][] = [];
  for(let tokenId of tokenIds) {
    // if(parseInfo.tokenIds[tokenId]) {
    //   let ix = parseInfo..indexOf(parseInfo.tokenIds[tokenId]);
    //   parseInfo.tokens.splice(ix, 1);
    //   parseInfo.tokenIds[tokenId] = undefined;
    // }

    let token = records[tokenId];
    if(!token) continue;
    let line = token.line[0];
    if(!lines[line]) {
      lines[line] = [];
    }
    parseInfo.tokenIds[tokenId] = {
      id: token.id[0],
      type: token.type[0],
      sort: token.sort[0],
      line: token.line[0],
      surrogateOffset: token.surrogateOffset[0],
      surrogateLength: token.surrogateLength[0]
    };
    lines[line].push(parseInfo.tokenIds[tokenId]);
  }

  for(let line of lines) {
    if(!line) continue;
    line.sort(sortComparator);
  }
  parseInfo.lines = lines;
  updateEditorParse(parseInfo);
}
indexes.byTag.subscribe(function(index, dirty) {
  if(!dirty["token"]) return;
  tokensToParseInfo(dirty["token"]);
});

function blocksToParseInfo(blockIds) {
  let records = indexes.records.index;

  // @FIXME: we don't want to be incremental right now, it's tough.
  blockIds = indexes.byTag.index["block"];


  let blocks:Block[] = [];
  for(let blockId of blockIds) {
    // if(parseInfo.blockIds[blockId]) {
    //   let ix = parseInfo.blocks.indexOf(parseInfo.blockIds[blockId]);
    //   parseInfo.blocks.splice(ix, 1);
    //   parseInfo.blockIds[blockId] = undefined;
    // }
    let block = records[blockId];
    if(!block) continue;
    parseInfo.blockIds[blockId] = {id: blockId, name: block.name[0], sort: block.sort[0], line: block.line[0]};
    blocks.push(parseInfo.blockIds[blockId]);
  }
  blocks.sort(sortComparator);
  parseInfo.blocks = blocks;
  updateEditorParse(parseInfo);
}
indexes.byTag.subscribe(function(index, dirty) {
  if(!dirty["block"]) return;
  blocksToParseInfo(dirty["block"]);
});

function handleEditorUpdates(index, dirty) {
  let blockIds:string[] = [];
  let tokenIds:string[] = [];
  for(let recordId in dirty) {
    if(parseInfo.blockIds[recordId]) blockIds.push(recordId);
    if(parseInfo.tokenIds[recordId]) tokenIds.push(recordId);
  }
  if(blockIds.length) blocksToParseInfo(blockIds);
  if(tokenIds.length) tokensToParseInfo(tokenIds);
}
indexes.dirty.subscribe(handleEditorUpdates);

function renderOnChange(index, dirty) {
  renderRecords();
}
indexes.dirty.subscribe(renderOnChange);

function printDebugRecords(index, dirty) {
  for(let recordId in dirty) {
    let record = indexes.records.index[recordId];
    if(record.tag && record.tag.indexOf("debug") !== -1) {
      console.info(record);
    }
  }
}
indexes.dirty.subscribe(printDebugRecords);


//---------------------------------------------------------
// Communication helpers
//---------------------------------------------------------

export function sendEvent(query) {
  //console.log("QUERY", query);
  if(socket && socket.readyState == 1) {
    socket.send(JSON.stringify({scope: "event", type: "query", query}))
  }
  return query;
}

export function sendSwap(query) {
  if(socket && socket.readyState == 1) {
    socket.send(JSON.stringify({scope: "root", type: "swap", query}))
  }
}

export function sendSave(query) {
  if(socket && socket.readyState == 1) {
    socket.send(JSON.stringify({scope: "root", type: "save", query}))
  }
}

export function sendParse(query) {
  if(socket && socket.readyState == 1) {
    socket.send(JSON.stringify({scope: "root", type: "parse", query}))
  }
}

//---------------------------------------------------------
// Handlers
//---------------------------------------------------------

function onHashChange(event) {
  let hash = window.location.hash.substr(1);
  if(hash[0] == "/") hash = hash.substr(1);
  let segments = hash.split("/").map(function(seg, ix) {
    return `[index: ${ix + 1}, value: "${seg}"]`;
  });
  let query =
  `hash changed remove any current url segments
    \`\`\`
    match
      url = [#url hash-segment]
    commit
      url.hash-segment -= hash-segment
    \`\`\`\n\n`;
  if(hash !== "") {
    query +=
    `hash changed if there isn't already a url, make one
      \`\`\`
      match
        not([#url])
      commit
        [#url hash-segment: ${segments.join(" ")}]
      \`\`\`
        \n\n` +
    `add the new hash-segments if there is
      \`\`\`
      match
        url = [#url]
      commit
        url <- [hash-segment: ${segments.join(" ")}]
      \`\`\`
    `;
  }
  sendEvent(query);
}

window.addEventListener("hashchange", onHashChange);
