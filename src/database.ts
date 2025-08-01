import express, {NextFunction, Response} from "express";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import {Collection, Db, MongoClient, ObjectId} from "mongodb";
import {authGuard} from "./auth";
import {noCache, verboseError} from "./util";
import {AuthenticatedRequest} from "./types";
import {ServerConfig} from "./config";
import * as fs from "fs";
import * as path from "path";
import { createFolderIfNotExists, initializeGitRepository, writeJsonFile, stageAndCommit, rollbackWorkspaceFolder, ensureFolderExists, deleteWorkspaceFolder, folderExists, cloneGitRepo, createGitBranch, checkoutGitBranch, listGitBranches, readWorkspaceJson, getGitCommitGraph, deleteGitBranch, getOrCreateUserWorktree, finalizeAndDeleteWorktree } from "./workspaceUtils";


const PREFERENCE_SCHEMA_VERSION = 2;
const LAYOUT_SCHEMA_VERSION = 2;
const SNIPPET_SCHEMA_VERSION = 1;
const WORKSPACE_SCHEMA_VERSION = 0;
//new
//const WORKSPACE_ROOT = "../src/data/workspaces"; //file system path
const WORKSPACE_ROOT = path.resolve(__dirname, "../data/workspaces"); //absolute path


const preferenceSchema = require("../config/preference_schema_2.json");
const layoutSchema = require("../config/layout_schema_2.json");
const snippetSchema = require("../config/snippet_schema.json");
const workspaceSchema = require("../config/workspace_schema_1.json");
const ajv = new Ajv({useDefaults: true, strictTypes: false});
addFormats(ajv);
const validatePreferences = ajv.compile(preferenceSchema);
const validateLayout = ajv.compile(layoutSchema);
const validateSnippet = ajv.compile(snippetSchema);
const validateWorkspace = ajv.compile(workspaceSchema);

let client: MongoClient;
let preferenceCollection: Collection;
let layoutsCollection: Collection;
let snippetsCollection: Collection;
let workspacesCollection: Collection;

// Helper: construct the file path for a given user's workspace.
function getWorkspaceFolder(workspaceId: string): string {
	return path.join(WORKSPACE_ROOT, workspaceId);
}


async function updateUsernameIndex(collection: Collection, unique: boolean) {
    const hasIndex = await collection.indexExists("username");
    if (!hasIndex) {
        await collection.createIndex({username: 1}, {name: "username", unique});
        console.log(`Created username index for collection ${collection.collectionName}`);
    }
}

async function createOrGetCollection(db: Db, collectionName: string) {
    const collectionExists = await db.listCollections({name: collectionName}, {nameOnly: true}).hasNext();
    if (collectionExists) {
        return db.collection(collectionName);
    } else {
        console.log(`Creating collection ${collectionName}`);
        return db.createCollection(collectionName);
    }
}

export async function initDB() {
    if (ServerConfig.database?.uri && ServerConfig.database?.databaseName) {
        try {
            client = await MongoClient.connect(ServerConfig.database.uri);
            const db = await client.db(ServerConfig.database.databaseName);
            layoutsCollection = await createOrGetCollection(db, "layouts");
            snippetsCollection = await createOrGetCollection(db, "snippets");
            preferenceCollection = await createOrGetCollection(db, "preferences");
            workspacesCollection = await createOrGetCollection(db, "workspaces");
            // Remove any existing validation in preferences collection
            await db.command({collMod: "preferences", validator: {}, validationLevel: "off"});
            // Update collection indices if necessary
            await updateUsernameIndex(layoutsCollection, false);
            await updateUsernameIndex(snippetsCollection, false);
            await updateUsernameIndex(workspacesCollection, false);
            await updateUsernameIndex(preferenceCollection, true);

            console.log(`Connected to ${client.options.dbName} on ${client.options.hosts} (Authenticated: ${client.options.credentials ? 'Yes': 'No'})`);
        } catch (err) {
            verboseError(err);
            console.error("Error connecting to database");
            process.exit(1);
        }
    } else {
        console.error("Database configuration not found");
        process.exit(1);
    }
}

async function handleGetPreferences(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    if (!req.username) {
        return next({statusCode: 403, message: "Invalid username"});
    }

    if (!preferenceCollection) {
        return next({statusCode: 501, message: "Database not configured"});
    }

    try {
        const doc = await preferenceCollection.findOne({username: req.username}, {projection: {_id: 0, username: 0}});
        if (doc) {
            res.json({success: true, preferences: doc});
        } else {
            return next({statusCode: 500, message: "Problem retrieving preferences"});
        }
    } catch (err) {
        verboseError(err);
        return next({statusCode: 500, message: "Problem retrieving preferences"});
    }
}

async function handleSetPreferences(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    if (!req.username) {
        return next({statusCode: 403, message: "Invalid username"});
    }

    if (!preferenceCollection) {
        return next({statusCode: 501, message: "Database not configured"});
    }

    const update = req.body;
    // Check for malformed update
    if (!update || !Object.keys(update).length || update.username || update._id) {
        return next({statusCode: 400, message: "Malformed preference update"});
    }

    update.version = PREFERENCE_SCHEMA_VERSION;

    const validUpdate = validatePreferences(update);
    if (!validUpdate) {
        console.log(validatePreferences.errors);
        return next({statusCode: 400, message: "Malformed preference update"});
    }

    try {
        const updateResult = await preferenceCollection.updateOne({username: req.username}, {$set: update}, {upsert: true});
        if (updateResult.acknowledged) {
            res.json({success: true});
        } else {
            return next({statusCode: 500, message: "Problem updating preferences"});
        }
    } catch (err) {
        verboseError(err);
        return next({statusCode: 500, message: err.errmsg});
    }
}

async function handleClearPreferences(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    if (!req.username) {
        return next({statusCode: 403, message: "Invalid username"});
    }

    if (!preferenceCollection) {
        return next({statusCode: 501, message: "Database not configured"});
    }

    const keys: string[] = req.body?.keys;
    // Check for malformed update
    if (!keys || !Array.isArray(keys) || !keys.length) {
        return next({statusCode: 400, message: "Malformed key list"});
    }

    const update: any = {};
    for (const key of keys) {
        update[key] = "";
    }

    try {
        const updateResult = await preferenceCollection.updateOne({username: req.username}, {$unset: update});
        if (updateResult.acknowledged) {
            res.json({success: true});
        } else {
            return next({statusCode: 500, message: "Problem clearing preferences"});
        }
    } catch (err) {
        verboseError(err);
        return next({statusCode: 500, message: "Problem clearing preferences"});
    }
}

async function handleGetLayouts(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    if (!req.username) {
        return next({statusCode: 403, message: "Invalid username"});
    }

    if (!layoutsCollection) {
        return next({statusCode: 501, message: "Database not configured"});
    }

    try {
        const layoutList = await layoutsCollection.find({username: req.username}, {projection: {_id: 0, username: 0}}).toArray();
        const layouts = {} as any;
        for (const entry of layoutList) {
            if (entry.name && entry.layout) {
                layouts[entry.name] = entry.layout;
            }
        }
        res.json({success: true, layouts});
    } catch (err) {
        verboseError(err);
        return next({statusCode: 500, message: "Problem retrieving layouts"});
    }
}

async function handleSetLayout(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    if (!req.username) {
        return next({statusCode: 403, message: "Invalid username"});
    }

    if (!layoutsCollection) {
        return next({statusCode: 501, message: "Database not configured"});
    }

    const layoutName = req.body?.layoutName;
    const layout = req.body?.layout;
    // Check for malformed update
    if (!layoutName || !layout || layout.layoutVersion !== LAYOUT_SCHEMA_VERSION) {
        return next({statusCode: 400, message: "Malformed layout update"});
    }

    const validUpdate = validateLayout(layout);
    if (!validUpdate) {
        console.log(validateLayout.errors);
        return next({statusCode: 400, message: "Malformed layout update"});
    }

    try {
        const updateResult = await layoutsCollection.updateOne({username: req.username, name: layoutName, layout}, {$set: {layout}}, {upsert: true});
        if (updateResult.acknowledged) {
            res.json({success: true});
        } else {
            return next({statusCode: 500, message: "Problem updating layout"});
        }
    } catch (err) {
        verboseError(err);
        return next({statusCode: 500, message: err.errmsg});
    }
}

async function handleClearLayout(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    if (!req.username) {
        return next({statusCode: 403, message: "Invalid username"});
    }

    if (!layoutsCollection) {
        return next({statusCode: 501, message: "Database not configured"});
    }

    const layoutName = req.body?.layoutName;
    try {
        const deleteResult = await layoutsCollection.deleteOne({username: req.username, name: layoutName});
        if (deleteResult.acknowledged) {
            res.json({success: true});
        } else {
            return next({statusCode: 500, message: "Problem clearing layout"});
        }
    } catch (err) {
        console.log(err);
        return next({statusCode: 500, message: "Problem clearing layout"});
    }
}

async function handleGetSnippets(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    if (!req.username) {
        return next({statusCode: 403, message: "Invalid username"});
    }

    if (!snippetsCollection) {
        return next({statusCode: 501, message: "Database not configured"});
    }

    try {
        const snippetList = await snippetsCollection.find({username: req.username}, {projection: {_id: 0, username: 0}}).toArray();
        const snippets = {} as any;
        for (const entry of snippetList) {
            if (entry.name && entry.snippet) {
                snippets[entry.name] = entry.snippet;
            }
        }
        res.json({success: true, snippets});
    } catch (err) {
        verboseError(err);
        return next({statusCode: 500, message: "Problem retrieving snippets"});
    }
}

async function handleSetSnippet(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    if (!req.username) {
        return next({statusCode: 403, message: "Invalid username"});
    }

    if (!snippetsCollection) {
        return next({statusCode: 501, message: "Database not configured"});
    }

    const snippetName = req.body?.snippetName;
    const snippet = req.body?.snippet;
    // Check for malformed update
    if (!snippetName || !snippet || snippet.snippetVersion !== SNIPPET_SCHEMA_VERSION) {
        return next({statusCode: 400, message: "Malformed snippet update"});
    }

    const validUpdate = validateSnippet(snippet);
    if (!validUpdate) {
        console.log(validateSnippet.errors);
        return next({statusCode: 400, message: "Malformed snippet update"});
    }

    try {
        const updateResult = await snippetsCollection.updateOne({username: req.username, name: snippetName, snippet}, {$set: {snippet}}, {upsert: true});
        if (updateResult.acknowledged) {
            res.json({success: true});
        } else {
            return next({statusCode: 500, message: "Problem updating snippet"});
        }
    } catch (err) {
        verboseError(err);
        return next({statusCode: 500, message: err.errmsg});
    }
}

async function handleClearSnippet(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    if (!req.username) {
        return next({statusCode: 403, message: "Invalid username"});
    }

    if (!snippetsCollection) {
        return next({statusCode: 501, message: "Database not configured"});
    }

    const snippetName = req.body?.snippetName;
    try {
        const deleteResult = await snippetsCollection.deleteOne({username: req.username, name: snippetName});
        if (deleteResult.acknowledged) {
            res.json({success: true});
        } else {
            return next({statusCode: 500, message: "Problem clearing snippet"});
        }
    } catch (err) {
        console.log(err);
        return next({statusCode: 500, message: "Problem clearing snippet"});
    }
}


async function handleClearWorkspace(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    if (!req.username) {
        return next({statusCode: 403, message: "Invalid username"});
    }

    if (!workspacesCollection) {
        return next({statusCode: 501, message: "Database not configured"});
    }

    const workspaceName = req.body?.workspaceName;
    // TODO: handle CRUD with workspace ID instead of name
    const workspaceId = req.body?.id;

    try {
        const deleteResult = await workspacesCollection.findOneAndDelete({users: req.username, name: workspaceName});
        
	if (!deleteResult.value) {
  		// No document was found to delete.
		return next({ statusCode: 404, message: "Workspace not found" });
	}

	// Extract ID
	const workspaceId = deleteResult.value._id.toString();

	if (deleteResult.ok && deleteResult.value) {
            // Determine the workspace folder path.
      	    const workspaceFolder = getWorkspaceFolder(workspaceId);
      	    console.log("Deleting workspace folder:", workspaceFolder);
	
	    // Attempt to remove the workspace folder (and its .git repo) recursively.
      	    await deleteWorkspaceFolder(workspaceFolder);   	

	    res.json({success: true});
        } else {
            return next({statusCode: 500, message: "Problem clearing workspace"});
        }
    } catch (err) {
        console.log(err);
        return next({statusCode: 500, message: "Problem clearing workspace"});
    }
}

async function handleGetWorkspaceList(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    if (!req.username) {
        return next({statusCode: 403, message: "Invalid username"});
    }

    if (!workspacesCollection) {
        return next({statusCode: 501, message: "Database not configured"});
    }

    try {
        const workspaceList = await workspacesCollection.find({users: req.username}, {projection: {_id: 1, name: 1, "workspace.date": 1}}).toArray();
        const workspaces = workspaceList?.map(w => ({...w, id: w._id, date: w.workspace?.date})) ?? [];
        res.json({success: true, workspaces});
    } catch (err) {
        verboseError(err);
        return next({statusCode: 500, message: "Problem retrieving workspaces"});
    }
}

async function handleGetWorkspaceByName(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    if (!req.username) {
        return next({statusCode: 403, message: "Invalid username"});
    }

    if (!req.params?.name) {
	    return next({statusCode: 403, message: "Invalid workspace name"});
    }

    if (!workspacesCollection) {
        return next({statusCode: 501, message: "Database not configured"});
    }

    try {
        const queryResult = await workspacesCollection.findOne({users: req.username, name: req.params.name}, {projection: {username: 0}});
        if (!queryResult) {
            return next({statusCode: 404, message: "Workspace not found"});
        }
        const workspaceId = queryResult._id.toString();
        const workspaceFolder = getWorkspaceFolder(workspaceId);
        
        // Fet branch from query or session, default to master 
        const branchName = typeof req.query.branchName === "string" && req.query.branchName.trim()
            ? req.query.branchName.replace(/^[^ ]* /, '')
            : "master";

        let workspaceData;
        let folderToRead = workspaceFolder;
        if (branchName !== "master") {
            folderToRead = await getOrCreateUserWorktree(workspaceFolder, req.username, branchName);
        }
        try {
            workspaceData = await readWorkspaceJson(folderToRead);
        } catch (err) {
            return next({statusCode: 500, message: "Could not read workspace JSON from branch"});
        }
        res.json({
            success: true,
            workspace: {
                id: workspaceId,
                name: queryResult.name,
                editable: true,
                users: queryResult.users, 
                ...workspaceData
            }
        });
    } catch (err) {
        verboseError(err);
        return next({statusCode: 500, message: "Problem retrieving workspace"});
    }
}


async function handleGetWorkspaceByKey(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    if (!req.username) {
        return next({statusCode: 403, message: "Invalid username"});
    }

    if (!req.params?.key) {
        return next({statusCode: 403, message: "Invalid workspace id"});
    }

    if (!workspacesCollection) {
        return next({statusCode: 501, message: "Database not configured"});
    }

    try {
        const objectId = Buffer.from(req.params.key, "base64url").toString("hex");
        console.log("objectID-", objectId)
        const queryResult = await workspacesCollection.findOne({_id: new ObjectId(objectId)});
        if (!queryResult) {
            return next({statusCode: 404, message: "Workspacesss not found"});
        } else if (!queryResult.users?.includes(req.username) && !queryResult.shared) {
            return next({statusCode: 403, message: "Workspace not accessible"});
        }
        const workspaceId = queryResult._id.toString();
        const workspaceFolder = getWorkspaceFolder( workspaceId);
        
        // Fetch branch from query or session, default to master 
        const branchName = typeof req.query.branchName === "string" && req.query.branchName.trim()
            ? req.query.branchName.replace(/^[^ ]* /, '')
            : "master";
        let workspaceData;
        let folderToRead = workspaceFolder;

        if (branchName !== "master") {
            folderToRead = await getOrCreateUserWorktree(workspaceFolder, req.username, branchName);
        }

        try {
            workspaceData = await readWorkspaceJson(folderToRead);
        } catch (err) {
            return next({statusCode: 500, message: "Could not read workspace JSON from branch"});
        }
        
        res.json({
            success: true,
            workspace: {
                id: workspaceId,
                name: queryResult.name,
                editable: queryResult.users?.includes(req.username),
                users: queryResult.users ?? [],
                ...workspaceData
            }
        });
    } catch (err) {
        verboseError(err);
        return next({statusCode: 500, message: "Problem retrieving workspace"});
    }
}

async function handleCreateWorkspace(req: AuthenticatedRequest, res: express.Response, next: express.NextFunction) {
    if (!req.username) {
        return next({statusCode: 403, message: "Invalid username"});
    }

    if (!workspacesCollection) {
        return next({statusCode: 501, message: "Database not configured"});
    }

    const workspaceName = req.body?.workspaceName;
    const workspace = req.body?.workspace;

    // Check for malformed update
    if (!workspaceName || !workspace || workspace.workspaceVersion !== WORKSPACE_SCHEMA_VERSION) {
        return next({statusCode: 400, message: "Malformed workspace update"});
    }

    const validUpdate = validateWorkspace(workspace);
    if (!validUpdate) {
        console.log(validateWorkspace.errors);
        return next({statusCode: 400, message: "Malformed workspace update"});
    }
	
    //use id instead of name for folder creation allowing name change
    const workspaceId = new ObjectId()

    let workspaceFolder: string;
    try{
    	//Compute the workspace directory path on disk.
        workspaceFolder = getWorkspaceFolder(workspaceId.toString());
        console.log("Computed workspace folder:", workspaceFolder);
	
	// Create workspace if it neccessary
	await createFolderIfNotExists(workspaceFolder);
    	
	// Initialize Git in this folder if not already initialized.
	await initializeGitRepository(workspaceFolder);

    	// Write the workspace JSON file 
        const workspaceJsonPath = path.join(workspaceFolder, "workspace.json");
   	await writeJsonFile(workspaceJsonPath, workspace);
    	
	// Stage and commit the file.
        const commitMessage = `Initial commit for workspace "${workspaceName}" by ${req.username}`;
	await stageAndCommit(workspaceFolder, commitMessage);

    } catch (fsOrGitError: any) {
    	console.error("Error during file system/Git operations:", fsOrGitError);
    	return next({ statusCode: 500, message: fsOrGitError.message || "Failed to perform Git operations" });
    }

    //Only if git functionalities successful    
    try{
	//workspace record in the database
        const updateResult = await workspacesCollection.findOneAndUpdate({users: [req.username], name: workspaceName}, {$set: {workspace}, $setOnInsert: { _id: workspaceId}}, {upsert: true, returnDocument: "after"});
	
	if (updateResult.ok && updateResult.value) {
            res.json({
                success: true,
                workspace: {
                    ...(workspace as any),
                    id: workspaceId.toString(), //using custom id
                    editable: true,
                    name: workspaceName
                }});
            return;
	} else {
      	    // If the DB update fails, roll back the Git operations by removing the folder.
            console.error("Database update failed; rolling back file system changes.");
            await rollbackWorkspaceFolder(workspaceFolder);
	    return next({ statusCode: 500, message: "Problem updating workspace in database" });
        }
          
    } catch (dbError: any) {
        console.error("Database error:", dbError);
        console.error("Rolling back file system changes.", dbError);
	// Roll back the Git operations if needed.
        await rollbackWorkspaceFolder(workspaceFolder);
	return next({ statusCode: 500, message: dbError.message || "Failed to update workspace in database" });
    }

}

async function handleSetWorkspace(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    if (!req.username) {
        return next({statusCode: 403, message: "Invalid username"});
    }

    if (!workspacesCollection) {
        return next({statusCode: 501, message: "Database not configured"});
    }

    const workspaceName = req.body?.workspaceName;
    const workspace = req.body?.workspace;
    const commitMessage = req.body?.commitMessage;
    const branchName = req.body?.branchName.replace(/^[^ ]* /, '') || "master"; // Default to master if not provided

    console.log("COMMIT:", commitMessage);
    console.log("BRANCH:", branchName);

    // Check for malformed update
    if (!workspaceName || !workspace || workspace.workspaceVersion !== WORKSPACE_SCHEMA_VERSION) {
        return next({statusCode: 400, message: "Malformed workspace update"});
    }

    const validUpdate = validateWorkspace(workspace);
    if (!validUpdate) {
        console.log(validateWorkspace.errors);
        return next({statusCode: 400, message: "Malformed workspace update"});
    }

    try {
        const updateResult = await workspacesCollection.findOneAndUpdate({users: req.username, name: workspaceName}, {$set: {workspace}}, {upsert: true, returnDocument: "after"});
       
       	if (!updateResult.value) {
    		return next({ statusCode: 500, message: "Workspace update failed: no document returned" });
}
	// Get the workspace id from the DB result and compute the workspace folder path.
        const workspaceId = updateResult.value._id.toString();
    	const workspaceFolder = getWorkspaceFolder(workspaceId);
    	
    // Use worktree for non-master branches
    let saveFolder = workspaceFolder;
    if (branchName !== "master") {
        saveFolder = await getOrCreateUserWorktree(workspaceFolder, req.username, branchName);
    }

	// Verify the folder exists-it should exist if the workspace is open
    	try {
            await ensureFolderExists(saveFolder);
        } catch { 
            return next({ statusCode: 500, message: "Workspace folder not found" });
        }


	// Write the updated workspace JSON file
    	const workspaceJsonPath = path.join(saveFolder, "workspace.json");
    	await writeJsonFile(workspaceJsonPath, workspace);
	console.log("Update workspace JSON written to:", workspaceJsonPath);
	
	// Stage and commit the changes.
	const finalCommitMessage = commitMessage && commitMessage.trim().length > 0
            ? commitMessage
            : `Updated workspace "${workspaceName}" by ${req.username} at ${new Date().toISOString()}`;
       	await stageAndCommit(saveFolder, finalCommitMessage);

	if (updateResult.ok && updateResult.value) {
            res.json({
                success: true,
                workspace: {
                    ...(workspace as any),
                    id: updateResult.value._id.toString(),
                    editable: true,
                    name: workspaceName
                }});
            return;
        } else {
            return next({statusCode: 500, message: "Problem updating workspace"});
        }
    } catch (err) {
        console.error("Error in handleSetWorkspace:", err);
    	return next({ statusCode: 500, message: err.message || "Failed to save workspace" });
    }
}

async function handleCloneWorkspace(req: AuthenticatedRequest, res: express.Response, next: express.NextFunction) {
    if (!req.username) {
        return next({ statusCode: 403, message: "Invalid username" });
    }
    if (!workspacesCollection) {
        return next({ statusCode: 501, message: "Database not configured" });
    }
    
    const sourceWorkspaceName = req.body?.workspaceName;
    
    console.log("FIne with extracting names")

    // Check for malformed update
    if (!sourceWorkspaceName) {
        console.log("No name")
	return next({statusCode: 400, message: "Workspace name required"});
    }

    try {
        // 1. Look up the source workspace record
        const sourceRecord = await workspacesCollection.findOne({ users: req.username, name: sourceWorkspaceName });
        if (!sourceRecord) {
            return next({ statusCode: 404, message: "Source workspace not found" });
        }
        console.log("source workspace found");	
	
	//get Id of source workspace to get
	const sourceWorkspaceId = sourceRecord._id.toString();

	//surely we can get the workspace itself from the db?
	const clonedWorkspace = { ...sourceRecord.workspace };
        const newWorkspaceId = new ObjectId();
        const dateStr = new Date().toISOString().replace(/[-:.TZ]/g, "");
        const newWorkspaceName = `clone_${sourceWorkspaceName}_${dateStr}`;

        // 2. Compute folder paths.
        const sourceFolder = getWorkspaceFolder( sourceWorkspaceId);
        const destinationFolder = getWorkspaceFolder(newWorkspaceId.toString());

	// Ensure the destination folder does not exist.
        if (await folderExists(destinationFolder)) {
            return next({ statusCode: 409, message: "Destination workspace already exists" });
        }

        // 3. Clone the repository.
        // Using git clone command: "git clone <sourceFolder> <destinationFolder>"
        await cloneGitRepo(sourceFolder, destinationFolder);
        console.log("Workspace cloned from", sourceFolder, "to", destinationFolder);
	console.log("All good with clones");
       
		
	//Too messy fix it
	
	// Insert a new document into the workspaces collection with the new name and cloned workspace data.	
	const insertResult = await workspacesCollection.findOneAndUpdate(
            {users: [req.username], name: newWorkspaceName},
            {
                $set: {
                    workspace: clonedWorkspace,
                    users: [req.username],
                    name: newWorkspaceName
                },
                $setOnInsert: { _id: newWorkspaceId }
            },
            {upsert: true, returnDocument: "after"}
        );
	
	if (insertResult.ok && insertResult.value){
	    res.json({
      	        success: true,
      	        workspace: {
                    ...(clonedWorkspace as any),
     		    id: newWorkspaceId,
                    editable: true,
                    name: newWorkspaceName
      	        }
	    });
	    return
	} else{
 	    console.error("Database update for clone failed; rolling back file system changes.");
	    return next({ statusCode: 500, message: "Problem updating cloned workspace in database" });
	}

    } catch (err: any) {
        console.error("Error cloning workspace:", err);
        return next({ statusCode: 500, message: err.message || "Failed to clone workspace" });
    }
}

async function handleBranchWorkspace(req: AuthenticatedRequest, res: express.Response, next: express.NextFunction) {

    if (!req.username) {
        return next({ statusCode: 403, message: "Invalid username" });
    }
    if (!workspacesCollection) {
        return next({ statusCode: 501, message: "Database not configured" });
    }
 

    console.log("Incoming body:", req.body);

    console.log("check 1 complete");    
    
    const workspaceName = req.body?.workspaceName;
    console.log("workspace name ", workspaceName);
    if (!workspaceName) {
        console.log("Workspace name error as we suspected")
	return next({ statusCode: 400, message: "Workspace name and branch name are required" });
    }
    console.log("check 2 complete");
    
    try {
        // 1. Look up the source workspace record
        const sourceRecord = await workspacesCollection.findOne({ users: req.username, name: workspaceName });
        if (!sourceRecord) {
            return next({ statusCode: 404, message: "Source workspace not found" });
        }
        console.log("source workspace found");
	
	//get Id of source workspace to get
        const workspaceId = sourceRecord._id.toString();


	// Compute the workspace folder.
        const workspaceFolder = getWorkspaceFolder( workspaceId);
        if (!(await folderExists(workspaceFolder))) {
            return next({ statusCode: 404, message: "Workspace folder not found" });
        }

	console.log("Workspace Folder found");
	const branchName = req.body?.branchName;
	if (!branchName) {
	    return next({ statusCode: 400, message: "Workspace name and branch name are required" });
	}

	// Create the new branch using Git:
        // The command checks out and creates a new branch in one step.
        await createGitBranch(workspaceFolder, branchName);
        console.log(`Branch "${branchName}" created in workspace "${workspaceName}" for user "${req.username}"`);
        
        // Immediately check out the original branch (e.g., "main") in the main workspace
        await checkoutGitBranch(workspaceFolder, "master"); 

    
    	
        res.json({
            success: true,
            message: `Branch "${branchName}" created for workspace "${workspaceName}"`
        });
    } catch (err: any) {
        console.error("Error creating branch:", err);
        return next({ statusCode: 500, message: err.message || "Failed to create branch" });
    }
}

async function handleDeleteWorkspaceBranch(req, res, next) {
    if (!req.username) return next({ statusCode: 403, message: "Invalid username" });
    if (!workspacesCollection) return next({ statusCode: 501, message: "Database not configured" });

    const { workspaceName, branchName } = req.body;
    if (!workspaceName || !branchName) return next({ statusCode: 400, message: "Workspace name and branch name required" });

    try {
        const workspace = await workspacesCollection.findOne({ users: req.username, name: workspaceName });
        if (!workspace) return next({ statusCode: 404, message: "Workspace not found" });
        const workspaceId = workspace._id.toString();
        const workspaceFolder = getWorkspaceFolder(workspaceId);

        await deleteGitBranch(workspaceFolder, branchName);
        res.json({ success: true });
    } catch (err) {
        return next({ statusCode: 500, message: err.message || "Failed to delete branch" });
    }
}

async function handleShareWorkspace(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    if (!req.username) {
        return next({statusCode: 403, message: "Invalid username"});
    }

    const id = req.params.id as string;
    if (!id) {
        return next({statusCode: 403, message: "Invalid workspace id"});
    }

    if (!workspacesCollection) {
        return next({statusCode: 501, message: "Database not configured"});
    }
    
    // Accept a username to share with, default to current user
    const shareWith = req.body?.username || req.username;
    //console.log("user is ", shareWith);

    try {
        const updateResult = await workspacesCollection.findOneAndUpdate(
            { _id: new ObjectId(id) },
            { $addToSet: { users: shareWith } } as any
        );
        if (updateResult.ok) {
            const shareKey = Buffer.from(id, "hex").toString("base64url");
            res.json({success: true, id, shareKey});
        } else {
            return next({statusCode: 500, message: "Problem sharing workspace"});
        }
    } catch (err) {
        verboseError(err);
        return next({statusCode: 500, message: err.errmsg});
    }
}

async function handleSwitchWorkspaceBranch(req: AuthenticatedRequest, res: express.Response, next: express.NextFunction) {
    if (!req.username) {
        return next({ statusCode: 403, message: "Invalid username" });
    }
    if (!workspacesCollection) {
        return next({ statusCode: 501, message: "Database not configured" });
    }

    const workspaceName = req.body?.workspaceName;
    const branchName = req.body?.newBranch.replace(/^[^ ]* /, ''); // Remove any leading "origin/" prefix like + or *
    const prevBranch = req.body?.prevBranch.replace(/^[^ ]* /, '');

    console.log("PREV BRANCH:", prevBranch);

    if (!workspaceName || !branchName || !prevBranch) {
        return next({ statusCode: 400, message: "Workspace name and branch name are required" });
    }

    try {
        const workspace = await workspacesCollection.findOne({ users: req.username, name: workspaceName });
        if (!workspace) {
            return next({ statusCode: 404, message: "Workspace not found" });
        }
        const workspaceId = workspace._id.toString();
        const workspaceFolder = getWorkspaceFolder( workspaceId);

        // Create or get the user's worktree for this branch
        //const userWorktreePath = await getOrCreateUserWorktree(workspaceFolder, req.username, branchName);

        // If switching from a previous branch, finalize and delete its worktree
        if (prevBranch && prevBranch !== branchName && prevBranch !== "master") {
            const prevWorktreePath = await getOrCreateUserWorktree(workspaceFolder, req.username, prevBranch);
            await finalizeAndDeleteWorktree(
                workspaceFolder,
                prevWorktreePath,
                prevBranch,
                `Sync changes from ${prevBranch} before switching to ${branchName}`
            );
        }

        let userWorktreePath: string;
        if (branchName === "master") {
            // Use the main workspace folder for master
            userWorktreePath = workspaceFolder;
        } else {
            // Create or get the user's worktree for this branch
            userWorktreePath = await getOrCreateUserWorktree(workspaceFolder, req.username, branchName);
        }

        //await checkoutGitBranch(workspaceFolder, branchName);

        res.json({ success: true, message: `Switched to branch "${branchName}" in workspace "${workspaceName}"` });
    } catch (err: any) {
        console.error("Error switching branch:", err);
        return next({ statusCode: 500, message: err.message || "Failed to switch branch" });
    }
}

async function handleListWorkspaceBranches(req: AuthenticatedRequest, res: express.Response, next: express.NextFunction) {
    if (!req.username) {
        return next({ statusCode: 403, message: "Invalid username" });
    }
    if (!workspacesCollection) {
        return next({ statusCode: 501, message: "Database not configured" });
    }

    const workspaceName = req.body?.workspaceName;
    if (!workspaceName) {
        return next({ statusCode: 400, message: "Workspace name is required" });
    }

    try {
        const workspace = await workspacesCollection.findOne({ users: req.username, name: workspaceName });
        if (!workspace) {
            return next({ statusCode: 404, message: "Workspace not found" });
        }
        const workspaceId = workspace._id.toString();
        const workspaceFolder = getWorkspaceFolder( workspaceId);

        const branchName = req.body?.branchName.replace(/^[^ ]* /, ''); // Remove any leading "origin/" prefix like + or *

        // Use the user's worktree for their current branch, fallback to main workspace
        let worktreeFolder = workspaceFolder;
        if (branchName && branchName !== "master") {
            worktreeFolder = await getOrCreateUserWorktree(workspaceFolder, req.username, branchName);
        }

        const { branches, current } = await listGitBranches(worktreeFolder);

        res.json({ success: true, branches, current });
    } catch (err: any) {
        console.error("Error listing branches:", err);
        return next({ statusCode: 500, message: err.message || "Failed to list branches" });
    }
}

async function handleGetWorkspaceTopology(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    if (!req.username) return next({ statusCode: 403, message: "Invalid username" });
    if (!workspacesCollection) return next({ statusCode: 501, message: "Database not configured" });

    const workspaceName = req.body?.workspaceName;
    if (!workspaceName) return next({ statusCode: 400, message: "Workspace name is required" });

    try {
        const workspace = await workspacesCollection.findOne({ users: req.username, name: workspaceName });
        if (!workspace) return next({ statusCode: 404, message: "Workspace not found" });
        const workspaceId = workspace._id.toString();
        const workspaceFolder = getWorkspaceFolder( workspaceId);

        const graph = await getGitCommitGraph(workspaceFolder);
        res.json({ success: true, graph });
    } catch (err) {
        console.error("Error getting branch topology:", err);
        return next({ statusCode: 500, message: err.message || "Failed to get branch topology" });
    }
}


export const databaseRouter = express.Router();

databaseRouter.get("/preferences", authGuard, noCache, handleGetPreferences);
databaseRouter.put("/preferences", authGuard, noCache, handleSetPreferences);
databaseRouter.delete("/preferences", authGuard, noCache, handleClearPreferences);

databaseRouter.get("/layouts", authGuard, noCache, handleGetLayouts);
databaseRouter.put("/layout", authGuard, noCache, handleSetLayout);
databaseRouter.delete("/layout", authGuard, noCache, handleClearLayout);

databaseRouter.get("/snippets", authGuard, noCache, handleGetSnippets);
databaseRouter.put("/snippet", authGuard, noCache, handleSetSnippet);
databaseRouter.delete("/snippet", authGuard, noCache, handleClearSnippet);

databaseRouter.post("/share/workspace/:id", authGuard, noCache, handleShareWorkspace);

databaseRouter.get("/list/workspaces", authGuard, noCache, handleGetWorkspaceList);
databaseRouter.get("/workspace/key/:key", authGuard, noCache, handleGetWorkspaceByKey);
databaseRouter.get("/workspace/:name", authGuard, noCache, handleGetWorkspaceByName);
databaseRouter.put("/setWorkspace", authGuard, noCache, handleSetWorkspace);
//new
databaseRouter.put("/createWorkspace", authGuard, noCache, handleCreateWorkspace);
databaseRouter.put("/cloneWorkspace", authGuard, noCache, handleCloneWorkspace);
databaseRouter.put("/branchWorkspace", authGuard, noCache, handleBranchWorkspace);
databaseRouter.delete("/workspace", authGuard, noCache, handleClearWorkspace);
databaseRouter.put("/switchWorkspaceBranch", authGuard, noCache, handleSwitchWorkspaceBranch);
databaseRouter.post("/listWorkspaceBranches", authGuard, noCache, handleListWorkspaceBranches);
databaseRouter.post("/workspaceTopology", authGuard, noCache, handleGetWorkspaceTopology);
databaseRouter.delete("/deleteWorkspaceBranch", authGuard, noCache, handleDeleteWorkspaceBranch);
