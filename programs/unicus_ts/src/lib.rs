use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke;
use anchor_spl::token::mint_to;
use anchor_spl::token::{MintTo, Token, TokenAccount, CloseAccount, Mint, Transfer};
use anchor_spl::token::{transfer, close_account};
use anchor_spl::associated_token::AssociatedToken;
use mpl_token_metadata::instruction::{create_metadata_accounts_v2};


declare_id!("5d1RwrEGymHuXAkHQTo7CAkBDhrVDsxUJs8b6jgtSFie");

#[program]
pub mod unicus_ts {

    use super::*;

    pub fn mint_nft(
    ctx: Context<MintNFT>,
    creator_key: Pubkey,
    name: String,
    symbol: String,
    uri: String,
    royalty: u16,
    ) -> Result<()> {
    
    if royalty > 10 {
        return Err(error!(MintError::RoyaltyExceeded));
    }
    
    //mpl_token_metadata::state::Metadata::from_account_info(a)
    msg!("Nft token minting:");
    let cpi_program = ctx.accounts.token_program.to_account_info();
    let cpi_accounts = MintTo {
        mint: ctx.accounts.mint.to_account_info(),
        to: ctx.accounts.token_account.to_account_info(),
        authority: ctx.accounts.payer.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
    let result = mint_to(cpi_ctx, 1);
    if let Err(_) = result {
        return Err(error!(MintError::MintFailed));
    }
    msg!("Token minted !!!");

    msg!("Metadata account creating:");
    let accounts = vec![
        ctx.accounts.token_metadata_program.to_account_info(),
        ctx.accounts.metadata.to_account_info(),
        ctx.accounts.mint.to_account_info(),
        ctx.accounts.mint_authority.to_account_info(),
        ctx.accounts.payer.to_account_info(),
        ctx.accounts.token_program.to_account_info(),
        ctx.accounts.system_program.to_account_info(),
        ctx.accounts.rent.to_account_info(),
    ];
    let creators = vec![
        mpl_token_metadata::state::Creator {         
            address: creator_key,
            verified: false,
            share: 100,
        },
    /*     mpl_token_metadata::state::Creator {
            address: ctx.accounts.mint_authority.key(),
            verified: false,
            share: 0,
        }, */
    ];
    let result = invoke(
        &create_metadata_accounts_v2(
            ctx.accounts.token_metadata_program.key(),
            ctx.accounts.metadata.key(),
            ctx.accounts.mint.key(),
            ctx.accounts.mint_authority.key(),
            ctx.accounts.payer.key(),
            ctx.accounts.payer.key(),
            name,
            symbol,
            uri,
            Some(creators),
            royalty,
            true,
            false,
            None,
            None,
        ),
        &accounts
    );
    if let Err(_) = result {
        return Err(error!(MintError::MetadataCreateFailed));
    }
    msg!("Metadata account created !!!");
    Ok(())
}


pub fn create_order(ctx: Context<CreateOrder>, memo: String, price: u64) -> Result<()> {
    let order = &mut ctx.accounts.order;

    anchor_lang::solana_program::program::invoke(
        &anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.creator.to_account_info().key(),
            &ctx.accounts.treasury_account.to_account_info().key(),
            (price * 2)/100
        ),
        &[
            ctx.accounts.creator.to_account_info(),
            ctx.accounts.treasury_account.to_account_info(),
            ctx.accounts.system_program.to_account_info()
        ]
        )?;

    order.creator = ctx.accounts.creator.key();
    order.mint_key = ctx.accounts.mint_key.key();
    order.memo = memo;
    order.price = price;
    order.bump = *ctx.bumps.get("order").unwrap();

    //
    // transfer nft from creator's token account into order's token account.
    //
    let cpi_accounts = Transfer {
        from: ctx.accounts.creator_token_account.to_account_info(),
        to: ctx.accounts.order_token_account.to_account_info(),
        authority: ctx.accounts.creator.to_account_info(),
    };
    let cpi_program = ctx.accounts.token_program.to_account_info();
    let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
    let result = transfer(cpi_ctx, 1);
    if let Err(_) = result {
        return Err(error!(MarketError::TokenTransferFailed));
    }

    return Ok(());
}

pub fn cancel_order(ctx: Context<CancelOrder>) -> Result<()> {
    //
    // Transfer nft from order token account back into creator's token account.
    //
    let cpi_program = ctx.accounts.token_program.to_account_info();
    let cpi_accounts = Transfer {
        from: ctx.accounts.order_token_account.to_account_info(),
        to: ctx.accounts.creator_token_account.to_account_info(),
        authority: ctx.accounts.order.to_account_info(),
    };
    let seeds = &[
        b"order",
        ctx.accounts.mint_key.to_account_info().key.as_ref(),
        &[ctx.accounts.order.bump]
    ];
    let signer = &[&seeds[..]];
    let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer);
    let result = transfer(cpi_ctx, 1);
    if let Err(_) = result {
        return Err(error!(MarketError::TokenTransferFailed2));
    }

    //
    // Close order token account.
    //
    let cpi_program = ctx.accounts.token_program.to_account_info();
    let cpi_accounts = CloseAccount {
        account: ctx.accounts.order_token_account.to_account_info(),
        destination: ctx.accounts.creator.to_account_info(),
        authority: ctx.accounts.order.to_account_info(),
    };
    let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer);
    let result = close_account(cpi_ctx);
    if let Err(_) = result {
        return Err(error!(MarketError::TokenCloseFailed));
    }

    return Ok(());
}

pub fn fill_order(ctx: Context<FillOrder>, seller_fee_basis_points: u16) -> Result<()> {
    let order = &mut ctx.accounts.order;
    let buyer = &mut ctx.accounts.buyer;
    let creator = &mut ctx.accounts.creator;
    let minter_account = &ctx.accounts.minter_account;

    //
    // Check buyer's balance against order's price.
    //
    if buyer.lamports() < order.price {
        return Err(error!(MarketError::InsufficientMoney));
    }

    //let metadata:Metadata = Metadata::from_account_info(&ctx.accounts.metadata)?;
    let royalty_points = seller_fee_basis_points as u64;
    let royalty = (order.price * royalty_points)/100;
    msg!("royalty {}", royalty);
    //let minter = metadata.update_authority;
    //msg!("minter {}", minter.to_string());

    let price = order.price - royalty as u64;
    msg!("price {}", price);
    //
    // Transfer Royalty to minter
    anchor_lang::solana_program::program::invoke(
        &anchor_lang::solana_program::system_instruction::transfer(
            &buyer.to_account_info().key(),
            &minter_account.to_account_info().key(),
            royalty
        ),
        &[
            buyer.to_account_info(),
            minter_account.to_account_info(),
            ctx.accounts.system_program.to_account_info()
        ]
    )?;




    //
    // Transfer order's money from buyer into creator.
    //
    anchor_lang::solana_program::program::invoke(
        &anchor_lang::solana_program::system_instruction::transfer(
            &buyer.to_account_info().key(),
            &creator.to_account_info().key(),
            price
        ),
        &[
            buyer.to_account_info(),
            creator.to_account_info(),
            ctx.accounts.system_program.to_account_info()
        ]
    )?;

    //
    // Transfer order token account's token into buyer token account.
    //
    let seeds = &[
        b"order",
        ctx.accounts.mint_key.key.as_ref(),
        &[order.bump]
    ];
    let signer = &[&seeds[..]];
    let cpi_program = ctx.accounts.token_program.to_account_info();
    let cpi_accounts = Transfer {
        from: ctx.accounts.order_token_account.to_account_info(),
        to: ctx.accounts.buyer_token_account.to_account_info(),
        authority: ctx.accounts.order.to_account_info()
    };
    let cpi_context = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer);
    let result = transfer(cpi_context, 1);
    if let Err(_) = result {
        return Err(error!(MarketError::TokenTransferFailed3));
    }

    //
    // Close order token account.
    //
    let cpi_program = ctx.accounts.token_program.to_account_info();
    let cpi_accounts = CloseAccount {
        account: ctx.accounts.order_token_account.to_account_info(),
        destination: ctx.accounts.creator.to_account_info(),
        authority: ctx.accounts.order.to_account_info(),
    };
    let cpi_context = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer);
    let result = close_account(cpi_context);
    if let Err(_) = result {
        return Err(error!(MarketError::TokenCloseFailed));
    }

    
    Ok(())
}


pub fn auction_resolve(ctx: Context<AuctionResolve>, seller_fee_basis_points: u16) -> Result<()> {
    let auction = &ctx.accounts.auction;
    //let minter_account = &ctx.accounts.minter_account;


    if (Clock::get()?.unix_timestamp as u128) < auction.end_time {
        return Err(error!(MarketError::AuctionNotEnded));
    }

    if auction.refund_receiver != auction.creator { 

        let royalty_points = seller_fee_basis_points as u64;
        let royalty = (auction.price * royalty_points)/100;
        msg!("royalty {}", royalty);


        // Transfer royalty to minter account

        **ctx.accounts.auction.to_account_info().try_borrow_mut_lamports()?  -= royalty;
        **ctx.accounts.minter_account.try_borrow_mut_lamports()? += royalty;


        let price = auction.price - royalty as u64;
        msg!("price {}", price);
        
        //
        // Transfer auction token account's token into winner token account.
        //
        let seeds = &[
            b"auction",
            ctx.accounts.mint_key.key.as_ref(),
            &[auction.bump],
        ];
        let signer = &[&seeds[..]];
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_accounts = Transfer {
            from: ctx.accounts.auction_token_account.to_account_info(),
            to: ctx.accounts.refund_receiver_token_account.to_account_info(),
            authority: auction.to_account_info(),
        };
        let cpi_context = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer);
        let result = transfer(cpi_context, 1);
        if let Err(_) = result {
            return Err(error!(MarketError::TokenTransferFailed3));
        }



        // Transfer bid price to creator account

        **ctx.accounts.auction.to_account_info().try_borrow_mut_lamports()?  -= price;
        **ctx.accounts.creator.try_borrow_mut_lamports()? += price;

        

    }


    
    //
    // Transfer nft from auction token account back into creator's token account.
    //
    let cpi_program = ctx.accounts.token_program.to_account_info();
    let cpi_accounts = Transfer {
        from: ctx.accounts.auction_token_account.to_account_info(),
        to: ctx.accounts.creator_token_account.to_account_info(),
        authority: auction.to_account_info(),
    };
    let seeds = &[
        b"auction",
        ctx.accounts.mint_key.to_account_info().key.as_ref(),
        &[auction.bump]
    ];
    let signer = &[&seeds[..]];
    let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer);
    let result = transfer(cpi_ctx, 1);
    if let Err(_) = result {
        return Err(error!(MarketError::TokenTransferFailed2));
    }
    
    //
    // Close auction token account.
    //
    let seeds = &[
        b"auction",
        ctx.accounts.mint_key.key.as_ref(),
        &[auction.bump],
    ];
    let signer = &[&seeds[..]];
    let cpi_program = ctx.accounts.token_program.to_account_info();
    let cpi_accounts = CloseAccount {
        account: ctx.accounts.auction_token_account.to_account_info(),
        destination: ctx.accounts.creator.to_account_info(),
        authority: auction.to_account_info(),
    };
    let cpi_context = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer);
    let result = close_account(cpi_context);
    if let Err(_) = result {
        return Err(error!(MarketError::TokenCloseFailed));
    }

    Ok(())
}


pub fn bid(ctx: Context<Bid>, price: u64) -> Result<()> {
    let auction = &ctx.accounts.auction;

   
    
    let bidder = &mut ctx.accounts.bidder;

    //
    // Check bidder's balance against auction's price.
    //
    if price < auction.price {
        return Err(error!(MarketError::InsufficientMoney));
    }

    if (Clock::get()?.unix_timestamp as u128) > auction.end_time {
        return Err(error!(MarketError::AuctionEnded));
    }


    //if refund_receiver exist return the money
    if auction.refund_receiver != auction.creator {

        
        **ctx.accounts.auction.to_account_info().try_borrow_mut_lamports()?  -= auction.price;
        **ctx.accounts.refund_receiver.try_borrow_mut_lamports()? += auction.price;


    }

    // Transfer bid price to auction  account

    anchor_lang::solana_program::program::invoke(
    &anchor_lang::solana_program::system_instruction::transfer(
        &bidder.to_account_info().key(),
        &auction.to_account_info().key(),
        price
    ),
    &[
        bidder.to_account_info(),
        auction.to_account_info(),
        ctx.accounts.system_program.to_account_info()
    ]
    )?;


    //update the auction info

    let auction = &mut ctx.accounts.auction;
    auction.refund_receiver = ctx.accounts.bidder.key();
    auction.price = price;  

    Ok(())

  
}


pub fn cancel_auction(ctx: Context<CancelAuction>) -> Result<()> {
    let auction = &ctx.accounts.auction;


    /*
    if ctx.accounts.refund_receiver.key() != Pubkey::default() || auction.refund_receiver {
        return Err(error!(MarketError::InvalidReceiver));
    } */

    //
    // Check if the auction is ended.
    //
    if (Clock::get()?.unix_timestamp as u128) > auction.end_time {
        return Err(error!(MarketError::AuctionEnded));
    }

    if auction.refund_receiver != auction.creator {


        **ctx.accounts.auction.to_account_info().try_borrow_mut_lamports()?  -= auction.price;
        **ctx.accounts.refund_receiver.try_borrow_mut_lamports()? += auction.price;


    }

    //
    // Transfer nft from auction token account back into creator's token account.
    //
    let cpi_program = ctx.accounts.token_program.to_account_info();
    let cpi_accounts = Transfer {
        from: ctx.accounts.auction_token_account.to_account_info(),
        to: ctx.accounts.creator_token_account.to_account_info(),
        authority: auction.to_account_info(),
    };
    let seeds = &[
        b"auction",
        ctx.accounts.mint_key.to_account_info().key.as_ref(),
        &[auction.bump]
    ];
    let signer = &[&seeds[..]];
    let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer);
    let result = transfer(cpi_ctx, 1);
    if let Err(_) = result {
        return Err(error!(MarketError::TokenTransferFailed2));
    }

    //
    // Close auction token account.
    //
    let cpi_program = ctx.accounts.token_program.to_account_info();
    let cpi_accounts = CloseAccount {
        account: ctx.accounts.auction_token_account.to_account_info(),
        destination: ctx.accounts.creator.to_account_info(),
        authority: auction.to_account_info(),
    };
    let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer);
    let result = close_account(cpi_ctx);
    if let Err(_) = result {
        return Err(error!(MarketError::TokenCloseFailed));
    }

    return Ok(());

}


pub fn create_auction(ctx: Context<CreateAuction>, memo: String, price: u64, start_time: u128, end_time: u128 ) -> Result<()> {
    let auction = &mut ctx.accounts.auction;

    if (Clock::get()?.unix_timestamp as u128) > end_time {
        return Err(error!(MarketError::InvalidEndTIme));
    }

    anchor_lang::solana_program::program::invoke(
        &anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.creator.to_account_info().key(),
            &ctx.accounts.treasury_account.to_account_info().key(),
            (price * 2)/100
        ),
        &[
            ctx.accounts.creator.to_account_info(),
            ctx.accounts.treasury_account.to_account_info(),
            ctx.accounts.system_program.to_account_info()
        ]
        )?;

    auction.creator = ctx.accounts.creator.key();
    auction.mint_key = ctx.accounts.mint_key.key();
    auction.refund_receiver = ctx.accounts.creator.key();
    auction.memo = memo;
    auction.price = price;
    auction.start_time = start_time;
    auction.end_time = end_time;
    auction.bump = *ctx.bumps.get("auction").unwrap();

    // transfer nft from creator's token account into auction's token account.
    //

    let cpi_accounts = Transfer {
        from: ctx.accounts.creator_token_account.to_account_info(),
        to: ctx.accounts.auction_token_account.to_account_info(),
        authority: ctx.accounts.creator.to_account_info(),
    };
    let cpi_program = ctx.accounts.token_program.to_account_info();
    let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
    let result = transfer(cpi_ctx, 1);
    if let Err(_) = result {
        return Err(error!(MarketError::TokenTransferFailed));
    }

    return Ok(());
} 


}




#[derive(Accounts)]
pub struct MintNFT<'info> {
    #[account(mut)]
    pub mint_authority: Signer<'info>,

    /// CHECK: This is not dangerous because we don't read or write from this account
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,

    /// CHECK: This is not dangerous because we don't read or write from this account
    #[account(mut)]
    pub metadata: UncheckedAccount<'info>,

    /// CHECK: This is not dangerous because we don't read or write from this account
    #[account(mut)]
    pub token_account: UncheckedAccount<'info>,

    /// CHECK: This is not dangerous because we don't read or write from this account
    pub token_metadata_program: UncheckedAccount<'info>,

    /// CHECK: This is not dangerous because we don't read or write from this account
    #[account(mut)]
    pub payer: AccountInfo<'info>,

    pub system_program: Program<'info, System>,

    /// CHECK: This is not dangerous because we don't read or write from this account
    pub rent: AccountInfo<'info>,
}


#[derive(Accounts)]
#[instruction(memo: String)]
pub struct CreateOrder<'info> {
    #[account(
        init,
        payer = creator,
        space = Order::space(&memo),
        seeds = [
            b"order",
            mint_key.key().as_ref(),
        ],
        bump
    )]
    pub order: Account<'info, Order>,

    #[account(
        init,
        payer = creator,
        associated_token::mint = mint_key,
        associated_token::authority = order
    )]
    pub order_token_account: Account<'info, TokenAccount>,

    pub mint_key: Account<'info, Mint>,

    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(
        mut, 
        constraint=creator_token_account.owner == creator.key(),
        constraint=creator_token_account.mint == mint_key.key()
    )]
    pub creator_token_account: Account<'info, TokenAccount>,
    /// CHECK: This account's address is only used.
    #[account(mut)]
    pub treasury_account: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct CancelOrder<'info> {
    #[account(
        mut,
        seeds = [
            b"order",
            mint_key.key().as_ref()
        ],
        bump,
        has_one = creator,
        close = creator
    )]
    pub order: Account<'info, Order>,

    #[account(
        mut,
        associated_token::mint = mint_key,
        associated_token::authority = order,
    )]
    pub order_token_account: Account<'info, TokenAccount>,

    pub mint_key: Account<'info, Mint>,

    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(
        mut,
        constraint=creator_token_account.owner == creator.key(),
        constraint=creator_token_account.mint == mint_key.key()
    )]
    pub creator_token_account: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}


#[derive(Accounts)]
pub struct FillOrder<'info> {
    #[account(
        mut,
        seeds = [
            b"order",
            mint_key.key.as_ref(),
        ],
        bump,
        has_one = creator,
        close = creator
    )]
    pub order: Account<'info, Order>,

    #[account(
        mut,
        associated_token::mint = order.mint_key,
        associated_token::authority = order,
    )]
    pub order_token_account: Account<'info, TokenAccount>,

    /// CHECK: This account's address is only used.
    pub mint_key: AccountInfo<'info>,

    /// CHECK: This account's address is only used.
    #[account(mut)]
    pub creator: AccountInfo<'info>,

    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(
        mut,
        constraint=buyer_token_account.owner == buyer.key(),
        constraint=buyer_token_account.mint == mint_key.key(),
    )]
    pub buyer_token_account: Account<'info, TokenAccount>,

    /// CHECK: This account's address is only used.
    #[account(mut)]
    pub minter_account: AccountInfo<'info>,  

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}



#[derive(Accounts)]
pub struct AuctionResolve<'info> {
    #[account(
        mut,
        seeds = [
            b"auction",
            mint_key.key.as_ref(),
        ],
        bump,
        has_one = creator,
        close = creator
    )]
    pub auction: Account<'info, Auction>,
    #[account(
        mut, 
        associated_token::mint = auction.mint_key,
        associated_token::authority = auction,
    )]
    pub auction_token_account: Account<'info, TokenAccount>,
    /// CHECK: This account's address is only used.
    pub mint_key: AccountInfo<'info>,

    /// CHECK: This account's address is only used.
    #[account(mut)]
    pub creator: AccountInfo<'info>,

    #[account(
        mut,
        constraint=creator_token_account.owner == creator.key(),
        constraint=creator_token_account.mint == mint_key.key()
    )]
    pub creator_token_account: Account<'info, TokenAccount>,

    /// CHECK: This account's address is only used.
    #[account(mut)]
    pub refund_receiver: AccountInfo<'info>,

    #[account(
        mut,
        constraint=refund_receiver_token_account.owner == refund_receiver.key(),
        constraint=refund_receiver_token_account.mint == mint_key.key(),
    )]
    pub refund_receiver_token_account: Account<'info, TokenAccount>,
    /// CHECK: This account's address is only used.
    #[account(mut)]
    pub minter_account: AccountInfo<'info>, 

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}


#[derive(Accounts)]
pub struct Bid<'info> {
    #[account(
        mut,
        seeds = [
            b"auction",
            mint_key.key.as_ref(),
        ],
        bump,
        has_one = creator
    )]
    pub auction: Account<'info, Auction>,

    /// CHECK: This account's address is only used.
    pub mint_key: AccountInfo<'info>,

    /// CHECK: This account's address is only used.
    #[account(mut)]
    pub creator: AccountInfo<'info>,

    #[account(mut)]
    pub bidder: Signer<'info>,

    /// CHECK: This account's address is only used.
    #[account(mut)]
    pub refund_receiver: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

//"refund_receiver.key == &Pubkey::default() || refund_receiver.key == &auction.refund_receiver"


#[derive(Accounts)]
pub struct CancelAuction<'info> {
    #[account(
        mut,
        seeds = [
            b"auction",
            mint_key.key().as_ref(),
        ],
        bump,
        has_one = creator,
        close = creator
    )]
    pub auction: Account<'info, Auction>,

    #[account(
        mut, 
        associated_token::mint = mint_key,
        associated_token::authority = auction,
    )]
    pub auction_token_account: Account<'info, TokenAccount>,

    /// CHECK: This account's address is only used.
    pub mint_key: Account<'info, Mint>,

    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(
        mut,
        constraint=creator_token_account.owner == creator.key(),
        constraint=creator_token_account.mint == mint_key.key()
    )]
    pub creator_token_account: Account<'info, TokenAccount>,

    /// CHECK: This account's address is only used.
    #[account(mut)]
    pub refund_receiver: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,


}


#[derive(Accounts)]
#[instruction(memo: String)]
pub struct CreateAuction<'info> {
    #[account(
        init,
        payer = creator,
        space = Auction::space(&memo),
        seeds = [
            b"auction",
            mint_key.key().as_ref(),
        ],
        bump
    )]
    pub auction: Account<'info, Auction>,

    #[account(
        init,
        payer = creator,
        associated_token::mint = mint_key,
        associated_token::authority = auction
    )]
    pub auction_token_account: Account<'info, TokenAccount>,

    pub mint_key: Account<'info, Mint>,

    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(
        mut, 
        constraint=creator_token_account.owner == creator.key(),
        constraint=creator_token_account.mint == mint_key.key()
    )]
    pub creator_token_account: Account<'info, TokenAccount>,

    /// CHECK: This account's address is only used.
    #[account(mut)]
    pub treasury_account: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub rent: Sysvar<'info, Rent>,
}


#[account]
pub struct Order {
    pub creator: Pubkey,
    pub mint_key: Pubkey,
    pub memo: String,
    pub price: u64,
    pub bump: u8,
}


#[account]
pub struct Auction {
    pub creator: Pubkey,
    pub mint_key: Pubkey,
    pub refund_receiver: Pubkey,
    pub memo: String,
    pub price: u64,
    pub start_time: u128,
    pub end_time: u128,
    pub bump: u8,
}


impl Order {
    pub fn space(memo: &str) -> usize {
        8 + 32 + 32 +
        4 + memo.len() + // memo string
        8 + 1
    }
}


impl Auction {
    pub fn space(memo: &str) -> usize {
        8 + 32 + 32 + 32 +
        4 + memo.len() + // memo string
        8 + 16 + 16 + 1
    }
}









#[error_code]
pub enum MintError {
    #[msg("Mint failed!")]
    MintFailed,

    #[msg("Metadata account create failed!")]
    MetadataCreateFailed,

    #[msg("Royalty cannot be more than 10")]
    RoyaltyExceeded,
}


#[error_code]
pub enum MarketError {
    #[msg("Token transfer from creator account into order account failed!")]
    TokenTransferFailed,

    #[msg("Token transfer from order account to creator account failed!")]
    TokenTransferFailed2,

    #[msg("Token transfer from order account to buyer account failed!")]
    TokenTransferFailed3,

    #[msg("sol transfer from order account to refund receiver account failed!")]
    SolTransferFailed,

    #[msg("Order token close failed!")]
    TokenCloseFailed,

    #[msg("Buyer account's sol balance is insufficient to buy order!")]
    InsufficientMoney,

    #[msg("Auction has ended...!")]
    AuctionEnded,

    #[msg("Auction end time must be greater than or equal to current time...!")]
    InvalidEndTIme,

    #[msg("Auction is going on...!")]
    AuctionNotEnded,

    #[msg("Invalid Refund Receiver address")]
    InvalidReceiver,
}

