import * as anchor from "@project-serum/anchor";
import { AnchorError, Program } from "@project-serum/anchor";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddress,
  createInitializeMintInstruction,
  MINT_SIZE,
  createMintToInstruction,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import { BN } from "bn.js";
import { assert, expect } from "chai";
import { UnicusTs } from "../target/types/unicus_ts";

const { LAMPORTS_PER_SOL } = anchor.web3;

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const mainProgram = anchor.workspace.UnicusTs as Program<UnicusTs>;

async function getAccountBalance(pubKey) {
  let account = await provider.connection.getAccountInfo(pubKey);
  return (account?.lamports ?? 0) / LAMPORTS_PER_SOL;
}

const createUser = async (airdropBalance: number) => {
  airdropBalance = airdropBalance * LAMPORTS_PER_SOL;
  let user = anchor.web3.Keypair.generate();
  const sig = await provider.connection.requestAirdrop(
    user.publicKey,
    airdropBalance
  );
  
  const latestBlockHash = await provider.connection.getLatestBlockhash();
  await provider.connection.confirmTransaction({
    blockhash: latestBlockHash.blockhash,
    lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
    signature: sig,
  });

  let wallet = new anchor.Wallet(user);
  let userProvider = new anchor.AnchorProvider(
    provider.connection,
    wallet,
    provider.opts
  );

  return {
    key: user,
    wallet,
    provider: userProvider,
  };
};


const programForUser = async (user) => {
  return new anchor.Program(
    mainProgram.idl,
    mainProgram.programId,
    user.provider
  );
};


const createMint = async (user) => {
  let mintKey = anchor.web3.Keypair.generate();
  const lamports =
    await mainProgram.provider.connection.getMinimumBalanceForRentExemption(
      MINT_SIZE
    );
  let associatedTokenAccount = await getAssociatedTokenAddress(
    mintKey.publicKey,
    user.key.publicKey
  );

  const mint_tx = new anchor.web3.Transaction().add(
    anchor.web3.SystemProgram.createAccount({
      fromPubkey: user.key.publicKey,
      newAccountPubkey: mintKey.publicKey,
      space: MINT_SIZE,
      programId: TOKEN_PROGRAM_ID,
      lamports,
    }),
    createInitializeMintInstruction(
      mintKey.publicKey,
      0,
      user.key.publicKey,
      user.key.publicKey
    )
  );

  try {
    const userProgram = await programForUser(user);
    const signature = await userProgram.provider.sendAndConfirm(mint_tx, [
      user.key,
      mintKey,
    ]);
  } catch (e) {
    console.log("createMint() failed!", e);
    return null;
  }

  return mintKey;
};


const createAssociateTokenAccount = async (
  mintKey: anchor.web3.PublicKey,
  user
) => {
  let associatedTokenAccount = await getAssociatedTokenAddress(
    mintKey,
    user.key.publicKey
  );

  const tx = new anchor.web3.Transaction().add(
    createAssociatedTokenAccountInstruction(
      user.key.publicKey,
      associatedTokenAccount,
      user.key.publicKey,
      mintKey
    )
  );

  try {
    const userProgram = await programForUser(user);
    const signature = await userProgram.provider.sendAndConfirm(tx, [user.key]);
  } catch (e) {
    console.log("createAssociateTokenAccount() failed!", e);
    return null;
  }

  return associatedTokenAccount;
};



const mintToken = async (mintKey: anchor.web3.Keypair, user) => {
  let associatedTokenAccount = await getAssociatedTokenAddress(
    mintKey.publicKey,
    user.key.publicKey
  );

  const tx = new anchor.web3.Transaction().add(
    createAssociatedTokenAccountInstruction(
      user.key.publicKey,
      associatedTokenAccount,
      user.key.publicKey,
      mintKey.publicKey
    ),
    createMintToInstruction(
      mintKey.publicKey,
      associatedTokenAccount,
      user.key.publicKey,
      1
    )
  );

  try {
    const userProgram = await programForUser(user);
    const signature = await userProgram.provider.sendAndConfirm(tx, [user.key]);
  } catch (e) {
    console.log("mintTo() failed!", e);
    return null;
  }

  return associatedTokenAccount;
};



const createOrder = async (
  user,
  mintKey: anchor.web3.Keypair,
  owner: anchor.web3.Keypair,
  ownerTokenAccount: anchor.web3.PublicKey,
  memo: string,
  price: number
) => {
  let program = await programForUser(user);
  const [orderAccount, bump] = await anchor.web3.PublicKey.findProgramAddress(
    [Buffer.from("order"), mintKey.publicKey.toBytes()],
    program.programId
  );

  const orderTokenAccount = await getAssociatedTokenAddress(
    mintKey.publicKey,
    orderAccount,
    true
  );

  await program.methods
    .createOrder(memo, new BN(price))
    .accounts({
      order: orderAccount,
      orderTokenAccount: orderTokenAccount,
      mintKey: mintKey.publicKey,
      creator: owner.publicKey,
      creatorTokenAccount: ownerTokenAccount,
    })
    .rpc();

  let order = await program.account.order.fetch(orderAccount);
  return {
    order,
    orderAccount,
    orderTokenAccount,
  };
};


const createAuction = async (
  user,
  mintKey: anchor.web3.Keypair,
  owner: anchor.web3.Keypair,
  ownerTokenAccount: anchor.web3.PublicKey,
  memo: string,
  price: number,
  start_time: number,
  end_time: number
) => {
  let program = await programForUser(user);
  const [auctionAccount, bump] = await anchor.web3.PublicKey.findProgramAddress(
    [Buffer.from("auction"), mintKey.publicKey.toBytes()],
    program.programId
  );

  const auctionTokenAccount = await getAssociatedTokenAddress(
    mintKey.publicKey,
    auctionAccount,
    true
  );

  await program.methods
    .createAuction(memo, new BN(price), new BN(start_time), new BN(end_time))
    .accounts({
      auction: auctionAccount,
      auctionTokenAccount: auctionTokenAccount,
      mintKey: mintKey.publicKey,
      creator: owner.publicKey,
      creatorTokenAccount: ownerTokenAccount,
    })
    .rpc();

  let auction = await program.account.auction.fetch(auctionAccount);
  return {
    auction,
    auctionAccount,
    auctionTokenAccount,
  };
};




const cancelOrder = async (
  user,
  mintKey: anchor.web3.Keypair,
  owner: anchor.web3.Keypair,
  ownerTokenAccount: anchor.web3.PublicKey
) => {
  let program = await programForUser(user);
  const [orderAccount, bump] = await anchor.web3.PublicKey.findProgramAddress(
    [Buffer.from("order"), mintKey.publicKey.toBytes()],
    program.programId
  );

  const orderTokenAccount = await getAssociatedTokenAddress(
    mintKey.publicKey,
    orderAccount,
    true
  );

  await program.methods
    .cancelOrder()
    .accounts({
      order: orderAccount,
      orderTokenAccount: orderTokenAccount,
      mintKey: mintKey.publicKey,
      creator: owner.publicKey,
      creatorTokenAccount: ownerTokenAccount,
    })
    .rpc();

  return {
    orderAccount,
    orderTokenAccount,
  };
};



const cancelAuction = async (
  user,
  mintKey: anchor.web3.PublicKey,
  owner: anchor.web3.Keypair,
  receiverKey: anchor.web3.PublicKey,
  ownerTokenAccount: anchor.web3.PublicKey
) => {
  let program = await programForUser(user);
  
  const [auctionAccount, bump] = await anchor.web3.PublicKey.findProgramAddress(
    [Buffer.from("auction"), mintKey.toBytes()],
    program.programId
  );

  const auctionTokenAccount = await getAssociatedTokenAddress(
    mintKey,
    auctionAccount,
    true
  );

  await program.methods
    .cancelAuction()
    .accounts({
      auction: auctionAccount,
      auctionTokenAccount: auctionTokenAccount,
      mintKey: mintKey,
      creator: owner.publicKey,
      creatorTokenAccount: ownerTokenAccount,
      refundReceiver: receiverKey,
    })
    .rpc();

  return {
    auctionAccount,
    auctionTokenAccount,
  };
};


const fillOrder = async (
  mintKey: anchor.web3.PublicKey,
  ownerKey: anchor.web3.PublicKey,
  buyer
) => {
  let program = await programForUser(buyer);
  const [orderAccount, bump] = await anchor.web3.PublicKey.findProgramAddress(
    [Buffer.from("order"), mintKey.toBytes()],
    program.programId
  );

  const orderTokenAccount = await getAssociatedTokenAddress(
    mintKey,
    orderAccount,
    true
  );

  let sellerPoints = 3;
  const buyerTokenAccount = await createAssociateTokenAccount(mintKey, buyer);

  await program.methods
    .fillOrder(sellerPoints)
    .accounts({
      order: orderAccount,
      orderTokenAccount: orderTokenAccount,
      mintKey: mintKey,
      creator: ownerKey,
      buyer: buyer.key.publicKey,
      buyerTokenAccount: buyerTokenAccount,
    })
    .rpc();

  return buyerTokenAccount;
};


const bidAuction = async (
  mintKey: anchor.web3.PublicKey,
  ownerKey: anchor.web3.PublicKey,
  receiverKey: anchor.web3.PublicKey,
  bidder,
  price: number
) => {
  let program = await programForUser(bidder);

  const [auctionAccount, bump] = await anchor.web3.PublicKey.findProgramAddress(
    [Buffer.from("auction"), mintKey.toBytes()],
    program.programId
  );


  try {
    await program.methods.bid(
      new BN(price)
    ).accounts({
      auction: auctionAccount,
      mintKey: mintKey,
      creator: ownerKey,
      bidder: bidder.key.publicKey,
      refundReceiver: receiverKey,
    }).rpc();
  } catch(err) {
      console.log(err);
  }

  let auction = await program.account.auction.fetch(auctionAccount);

  return {
    auctionAccount,
    auction
  };
  

}




const auctionResolve = async (
  user,
  mintKey: anchor.web3.PublicKey,
  ownerKey: anchor.web3.PublicKey,
  receiverKey: anchor.web3.PublicKey,
  creatorTokenAccount: anchor.web3.PublicKey,
) => {
  let program = await programForUser(user);

  const [auctionAccount, bump] = await anchor.web3.PublicKey.findProgramAddress(
    [Buffer.from("auction"), mintKey.toBytes()],
    program.programId
  );

  const auctionTokenAccount = await getAssociatedTokenAddress(
    mintKey,
    auctionAccount,
    true
  );

    let sellerPoints = 3;
  /*const refundReceiverTokenAccount = await createAssociateTokenAccount(mintKey, receiverKey);
  const refundReceiverTokenAccount = await getAssociatedTokenAddress(
    mintKey,
    auctionAccount,
    true
  ); */

  const refundReceiverTokenAccount = await getOrCreateAssociatedTokenAccount(
    program.provider.connection,
    user,
    mintKey,
    receiverKey,
    true
  );
  console.log("refundREciver token aacct", refundReceiverTokenAccount.address.toString());


  try {
    await program.methods.auctionResolve(sellerPoints)
    .accounts({
      auction: auctionAccount,
      auctionTokenAccount: auctionTokenAccount,
      mintKey: mintKey,
      creator: ownerKey,
      creatorTokenAccount: creatorTokenAccount,
      refundReceiver: receiverKey,
      refundReceiverTokenAccount: refundReceiverTokenAccount.address
    }).rpc();
  } catch(err) {
      console.log(err);
  }

  console.log("auction resolved");
  let auction = await program.account.auction.fetch(auctionAccount);

  return {
    auctionAccount,
    auction,
    auctionTokenAccount,
    refundReceiverTokenAccount
  };
  

}










describe("unicus_ts", () => {

/*
  
  it("create order", async () => {
    let user = await createUser(1);
    console.log("User Account: ", user.key.publicKey.toString());

    //
    // Create mint.
    //
    const mintKey = await createMint(user);
    console.log("Mint key: ", mintKey.publicKey.toString());

    //
    // Mint a token.
    //
    const tokenAccount = await mintToken(mintKey, user);
    console.log("Owner Token Account: ", tokenAccount.toString());

    var balance = await mainProgram.provider.connection.getTokenAccountBalance(
      tokenAccount
    );
    console.log("Owner Token Account Balance: ", balance.value.uiAmount);
    expect(balance.value.uiAmount).equals(1);

    //
    // Create an order.
    //
    let order = await createOrder(
      user,
      mintKey,
      user.key,
      tokenAccount,
      "This is test order.",
      1 * LAMPORTS_PER_SOL
    );
    console.log("[Order Created]");
    console.log("Order Account: ", order.orderAccount.toString());
    console.log("Order Token Account: ", order.orderTokenAccount.toString());
    console.log("Order.creator: ", order.order.creator.toString());
    console.log("Order.mintKey: ", order.order.mintKey.toString());
    console.log("Order.memo: ", order.order.memo);
    console.log("Order.price: ", order.order.price.toNumber());

    //
    // Check result.
    //
    balance = await mainProgram.provider.connection.getTokenAccountBalance(
      tokenAccount
    );
    console.log("Owner Token Account Balance: ", balance.value.uiAmount);
    expect(balance.value.uiAmount).equals(0);

    balance = await mainProgram.provider.connection.getTokenAccountBalance(
      order.orderTokenAccount
    );
    console.log("Order Token Account Balance: ", balance.value.uiAmount);
    expect(balance.value.uiAmount).equals(1);

    expect(order.order.creator.toString()).equals(
      user.key.publicKey.toString()
    );
    expect(order.order.mintKey.toString()).equals(mintKey.publicKey.toString());
    expect(order.order.memo).equals("This is test order.");
    expect(order.order.price.toNumber()).equals(1 * LAMPORTS_PER_SOL);
  });



  it("cancel order", async () => {
    let user = await createUser(1);
    console.log("User Account: ", user.key.publicKey.toString());

    //
    // Create mint.
    //
    const mintKey = await createMint(user);
    console.log("Mint key: ", mintKey.publicKey.toString());

    //
    // Mint a token.
    //
    const tokenAccount = await mintToken(mintKey, user);
    console.log("Owner Token Account: ", tokenAccount.toString());

    var balance = await mainProgram.provider.connection.getTokenAccountBalance(
      tokenAccount
    );
    console.log("Owner Token Account Balance: ", balance.value.uiAmount);
    expect(balance.value.uiAmount).equals(1);

    //
    // Create an order.
    //
    var order = await createOrder(
      user,
      mintKey,
      user.key,
      tokenAccount,
      "This is test order.",
      1 * LAMPORTS_PER_SOL
    );
    console.log("[Order Created]");
    console.log("Order Account: ", order.orderAccount.toString());
    console.log("Order Token Account: ", order.orderTokenAccount.toString());

    //
    // Check result.
    //
    balance = await mainProgram.provider.connection.getTokenAccountBalance(
      tokenAccount
    );
    console.log("Owner Token Account Balance: ", balance.value.uiAmount);
    expect(balance.value.uiAmount).equals(0);

    balance = await mainProgram.provider.connection.getTokenAccountBalance(
      order.orderTokenAccount
    );
    console.log("Order Token Account Balance: ", balance.value.uiAmount);
    expect(balance.value.uiAmount).equals(1);

    //
    // Cancel order.
    //
    //@ts-ignore
    order = await cancelOrder(user, mintKey, user.key, tokenAccount);
    console.log("[Order Canceled]");

    //
    // Check result.
    //
    balance = await mainProgram.provider.connection.getTokenAccountBalance(
      tokenAccount
    );
    console.log("Owner Token Account Balance: ", balance.value.uiAmount);
    expect(balance.value.uiAmount).equals(1);

    let orderAccountInfo = await mainProgram.provider.connection.getAccountInfo(
      order.orderAccount
    );
    console.log("Order Account: ", orderAccountInfo);
    expect(orderAccountInfo).equals(null);

    try {
      balance = await mainProgram.provider.connection.getTokenAccountBalance(
        order.orderTokenAccount
      );
      assert(false, "Order token account should be closed by cancel program.");
    } catch (e) {
      expect(e.toString()).contain("could not find account");
    }
  });



  it("fill order", async () => {
    let user = await createUser(1);
    console.log("User Account: ", user.key.publicKey.toString());

    let buyer = await createUser(2);
    console.log("Buyer Account: ", buyer.key.publicKey.toString());

    //
    // Create mint.
    //
    const mintKey = await createMint(user);
    console.log("Mint key: ", mintKey.publicKey.toString());

    //
    // Mint a token.
    //
    const tokenAccount = await mintToken(mintKey, user);
    console.log("Owner Token Account: ", tokenAccount.toString());

    var balance = await mainProgram.provider.connection.getTokenAccountBalance(
      tokenAccount
    );
    expect(balance.value.uiAmount).equals(1);

    //
    // Create an order.
    //
    var order = await createOrder(
      user,
      mintKey,
      user.key,
      tokenAccount,
      "This is test order.",
      1 * LAMPORTS_PER_SOL
    );
    console.log("[Order Created]");
    console.log("Order Account: ", order.orderAccount.toString());
    console.log("Order Token Account: ", order.orderTokenAccount.toString());

    console.log(
      "Creator Account Balance: ",
      await getAccountBalance(user.key.publicKey)
    );
    console.log(
      "Buyer Account Balance: ",
      await getAccountBalance(buyer.key.publicKey)
    );

    //
    // Fill order.
    //
    let buyerTokenAccount = await fillOrder(
      mintKey.publicKey,
      user.key.publicKey,
      buyer
    );
    console.log("[Order Filled]");
    console.log("Buyer Token Account: ", buyerTokenAccount.toString());
    console.log(
      "Creator Account Balance: ",
      await getAccountBalance(user.key.publicKey)
    );
    console.log(
      "Buyer Account Balance: ",
      await getAccountBalance(buyer.key.publicKey)
    );

    //
    // Check result.
    //
    balance = await mainProgram.provider.connection.getTokenAccountBalance(
      tokenAccount
    );
    console.log("Owner Token Account Balance: ", balance.value.uiAmount);
    expect(balance.value.uiAmount).equals(0);

    balance = await mainProgram.provider.connection.getTokenAccountBalance(
      buyerTokenAccount
    );
    console.log("Buyer Token Account Balance: ", balance.value.uiAmount);
    expect(balance.value.uiAmount).equals(1);

    let orderAccountInfo = await mainProgram.provider.connection.getAccountInfo(
      order.orderAccount
    );
    console.log("Order Account: ", orderAccountInfo);
    expect(orderAccountInfo).equals(null);

    try {
      balance = await mainProgram.provider.connection.getTokenAccountBalance(
        order.orderTokenAccount
      );
      assert(false, "Order token account should be closed by fill program.");
    } catch (e) {
      expect(e.toString()).contain("could not find account");
    }
  });


  it("fill order insufficient money error check", async () => {
    let user = await createUser(1);
    console.log("User Account: ", user.key.publicKey.toString());

    let buyer = await createUser(1);
    console.log("Buyer Account: ", buyer.key.publicKey.toString());

    //
    // Create mint.
    //
    const mintKey = await createMint(user);
    console.log("Mint key: ", mintKey.publicKey.toString());

    //
    // Mint a token.
    //
    const tokenAccount = await mintToken(mintKey, user);
    console.log("Owner Token Account: ", tokenAccount.toString());

    //
    // Create an order.
    //
    var order = await createOrder(
      user,
      mintKey,
      user.key,
      tokenAccount,
      "This is test order.",
      2 * LAMPORTS_PER_SOL
    );
    console.log("[Order Created]");
    console.log("Order Account: ", order.orderAccount.toString());
    console.log("Order Token Account: ", order.orderTokenAccount.toString());

    console.log(
      "Creator Account Balance: ",
      await getAccountBalance(user.key.publicKey)
    );
    console.log(
      "Buyer Account Balance: ",
      await getAccountBalance(buyer.key.publicKey)
    );

    try {
      //
      // Fill order.
      //
      await fillOrder(mintKey.publicKey, user.key.publicKey, buyer);
      assert(
        false,
        "Fill order should be failed because buyer has no enough money."
      );
    } catch (err) {
      expect(err).to.be.instanceOf(AnchorError);
      const anchorError = err as AnchorError;
      expect(anchorError.error.errorCode.number).equals(6005);
      expect(anchorError.error.errorCode.code).equals("InsufficientMoney");
    }
  });


  
  it("create auction", async () => {
    let user = await createUser(1); 
    console.log("User Account: ", user.key.publicKey.toString());
    //
    // Create mint.
    //
    const mintKey = await createMint(user);
    console.log("Mint key: ", mintKey.publicKey.toString());
    //
    // Mint a token.
    //
    const tokenAccount = await mintToken(mintKey, user);
    console.log("Owner Token Account: ", tokenAccount.toString());
    var balance = await mainProgram.provider.connection.getTokenAccountBalance(
      tokenAccount
    );
    console.log("Owner Token Account Balance: ", balance.value.uiAmount);
    expect(balance.value.uiAmount).equals(1);
    //
    // Create an auction.
    //
    let auction = await createAuction(
      user,
      mintKey,
      user.key,
      tokenAccount,
      "This is test order.",
      1 * LAMPORTS_PER_SOL,
      1659518580,
      1659528580
    );
    console.log("[Auction Created]");
    console.log("Auction Account: ", auction.auctionAccount.toString());
    console.log("Auction Token Account: ", auction.auctionTokenAccount.toString());
    console.log("Auction.creator: ", auction.auction.creator.toString());
    console.log("Auction.mintKey: ", auction.auction.mintKey.toString());
    console.log("Auction.memo: ", auction.auction.memo);
    console.log("Auction.price: ", auction.auction.price.toNumber());
    console.log("Auction.start_time: ", auction.auction.startTime.toNumber());
    console.log("Auction.end_time: ", auction.auction.endTime.toNumber());
    //
    // Check result.
    //
    balance = await mainProgram.provider.connection.getTokenAccountBalance(
      tokenAccount
    );
    console.log("Owner Token Account Balance: ", balance.value.uiAmount);
    expect(balance.value.uiAmount).equals(0);
    balance = await mainProgram.provider.connection.getTokenAccountBalance(
      auction.auctionTokenAccount
    );
    console.log("Auction Token Account Balance: ", balance.value.uiAmount);
    expect(balance.value.uiAmount).equals(1);
    expect(auction.auction.creator.toString()).equals(
      user.key.publicKey.toString()
    );
    expect(auction.auction.mintKey.toString()).equals(mintKey.publicKey.toString());
    expect(auction.auction.memo).equals("This is test order.");
    expect(auction.auction.price.toNumber()).equals(1 * LAMPORTS_PER_SOL);
  });



  
  it("bid auction", async () => {
    let user = await createUser(1);
    console.log("User Account: ", user.key.publicKey.toString());

    let bidder = await createUser(2);
    console.log("Bidder Account: ", bidder.key.publicKey.toString());

    //
    // Create mint.
    //
    const mintKey = await createMint(user);
    console.log("Mint key: ", mintKey.publicKey.toString());

    //
    // Mint a token.
    //
    const tokenAccount = await mintToken(mintKey, user);
    console.log("Owner Token Account: ", tokenAccount.toString());

    var balance = await mainProgram.provider.connection.getTokenAccountBalance(
      tokenAccount
    );
    expect(balance.value.uiAmount).equals(1);

    //
    // Create an order. 1663319647  1663146847
    //
    let auction = await createAuction(
      user,
      mintKey,
      user.key,
      tokenAccount,
      "This is test auction.",
      1 * LAMPORTS_PER_SOL,
      1663146847,
      1663319647
    );
    console.log("[Auction Created]");
    console.log("AUction Account: ", auction.auctionAccount.toString());
    console.log("Auction Token Account: ", auction.auctionTokenAccount.toString());

    console.log(
      "Creator Account Balance: ",
      await getAccountBalance(user.key.publicKey)
    );
    console.log(
      "Bidder Account Balance: ",
      await getAccountBalance(bidder.key.publicKey)
    );

    console.log("refund receiver", auction.auction.refundReceiver.toString());

    //
    // Fill order.
    //
    let bid = await bidAuction(
      mintKey.publicKey,
      user.key.publicKey,
      auction.auction.refundReceiver,
      bidder,
      1 * LAMPORTS_PER_SOL
    );
    console.log("[Bid Filled]");
    
    console.log(
      "Creator Account Balance: ",
      await getAccountBalance(user.key.publicKey)
    );
    console.log(
      "Bidder Account Balance: ",
      await getAccountBalance(bidder.key.publicKey)
    );

    //
    // Check result.
    //
    console.log("bid winner is", bid.auction.refundReceiver.toString());
    console.log("new auction price is", bid.auction.price.toNumber());

  });



  
  it("cancel auction", async () => {
    let user = await createUser(1);
    console.log("User Account: ", user.key.publicKey.toString());

    //
    // Create mint.
    //
    const mintKey = await createMint(user);
    console.log("Mint key: ", mintKey.publicKey.toString());

    //
    // Mint a token.
    //
    const tokenAccount = await mintToken(mintKey, user);
    console.log("Owner Token Account: ", tokenAccount.toString());

    var balance = await mainProgram.provider.connection.getTokenAccountBalance(
      tokenAccount
    );
    console.log("Owner Token Account Balance: ", balance.value.uiAmount);
    expect(balance.value.uiAmount).equals(1);

    //
    // Create an auction.
    //
    let auction = await createAuction(
      user,
      mintKey,
      user.key,
      tokenAccount,
      "This is test auction.",
      1 * LAMPORTS_PER_SOL,
      1663146847,
      1663319647
    );
    console.log("[Auction Created]");
    console.log("AUction Account: ", auction.auctionAccount.toString());
    console.log("Auction Token Account: ", auction.auctionTokenAccount.toString());

    //
    // Check result.
    //
    balance = await mainProgram.provider.connection.getTokenAccountBalance(
      tokenAccount
    );
    console.log("Owner Token Account Balance: ", balance.value.uiAmount);
    expect(balance.value.uiAmount).equals(0);

    //
    // Cancel auction
    //
    //@ts-ignore
    auction = await cancelAuction(user, mintKey.publicKey, user.key, auction.auction.refundReceiver, tokenAccount);
    console.log("[auction Canceled]");

  

    let auctionAccountInfo = await mainProgram.provider.connection.getAccountInfo(
      auction.auctionAccount
    );
    console.log("auction Account: ", auctionAccountInfo);
    expect(auctionAccountInfo).equals(null);

    try {
      balance = await mainProgram.provider.connection.getTokenAccountBalance(
        auction.auctionTokenAccount
      );
      assert(false, "Auction token account should be closed by cancel program.");
    } catch (e) {
      expect(e.toString()).contain("could not find account");
    }
  });



*/
  
  it("auction resolve", async () => {
    let user = await createUser(1);
    //console.log("User Account: ", user.key.publicKey.toString());

    let bidder = await createUser(2);
    //console.log("Bidder Account: ", bidder.key.publicKey.toString());

    //
    // Create mint.
    //
    const mintKey = await createMint(user);
    console.log("Mint key: ", mintKey.publicKey.toString());

    //
    // Mint a token.
    //
    const tokenAccount = await mintToken(mintKey, user);
    console.log("Owner Token Account: ", tokenAccount.toString());

    var balance = await mainProgram.provider.connection.getTokenAccountBalance(
      tokenAccount
    );
    expect(balance.value.uiAmount).equals(1);

    //
    // Create an order. 1663319647  1663146847
    //
    let auction = await createAuction(
      user,
      mintKey,
      user.key,
      tokenAccount,
      "This is test auction.",
      1 * LAMPORTS_PER_SOL,
      1664463230,
      1664473230
    );
    console.log("[Auction Created]");
    //console.log("AUction Account: ", auction.auctionAccount.toString());
    //console.log("Auction Token Account: ", auction.auctionTokenAccount.toString());

    console.log(
      "Creator Account Balance: ",
      await getAccountBalance(user.key.publicKey)
    );
    /*console.log(
      "Bidder Account Balance: ",
      await getAccountBalance(bidder.key.publicKey)
    );

   console.log("refund receiver", auction.auction.refundReceiver.toString());
    console.log("creator", auction.auction.creator.toString());
    console.log("mintkey", mintKey.publicKey.toString());
    console.log("mintkey", user.key.publicKey.toString());

    //
    // Fill order.
    //
    let bid = await bidAuction(
      mintKey.publicKey,
      user.key.publicKey,
      auction.auction.refundReceiver,
      bidder,
      1 * LAMPORTS_PER_SOL
    );
    console.log("[Bid Filled]");
    
    console.log(
      "Creator Account Balance: ",
      await getAccountBalance(user.key.publicKey)
    );
    console.log(
      "Bidder Account Balance: ",
      await getAccountBalance(bidder.key.publicKey)
    );

    //
    // Check result.
    //
    console.log("bid winner is", bid.auction.refundReceiver.toString()); */
 /*   console.log("new auction price is", bid.auction.price.toNumber());   

    console.log(
      "Bid winner Balance: ",
      await getAccountBalance(bid.auction.refundReceiver)
    );*/

    //console.log("user", user.key.publicKey.toString());
    //console.log("mint", mintKey.publicKey.toString());
    //console.log("auction creator", auction.auction.creator.toString());
    //console.log("auction creator", auction.auction.refundReceiver.toString());
    
     await auctionResolve(
        user.key,
        mintKey.publicKey,
        auction.auction.creator,
        auction.auction.refundReceiver,
        tokenAccount
      );
    
//user.key.publicKey
    console.log("auction resolve successful");

    


/*
    let auctionAccountInfo = await mainProgram.provider.connection.getAccountInfo(
      (await executeAuction).auctionAccount
    );
    console.log("auction Account: ", auctionAccountInfo);
    expect(auctionAccountInfo).equals(null);

    try {
      balance = await mainProgram.provider.connection.getTokenAccountBalance(
        (await executeAuction).auctionAccount
      );
      assert(false, "Auction token account should be closed by cancel program.");
    } catch (e) {
      expect(e.toString()).contain("could not find account");
    }


    let receiverTokenBalance = await mainProgram.provider.connection.getTokenAccountBalance(
      (await executeAuction).refundReceiverTokenAccount
    );

    console.log("receiver token balance", receiverTokenBalance);

*/





  });



  






});
